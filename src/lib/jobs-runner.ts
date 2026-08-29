import { withConnection } from "./storage-context";
import { z } from "zod";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { getDb } from "./db";
import { abortMultipart, deleteObject } from "./storage";
import { constantTimeEqual } from "./security";
import {
  deadLetterJob,
  claimNextJob,
  completeJob,
  isJobKind,
  retryJob
} from "./jobs";
import {
  finalizePurge,
  prepareExpiredUploadCleanup,
  reconcileOwnerUsage,
  trashCutoff
} from "./files";
import {
  boundedBatchSize,
  boundedLeaseSeconds,
  MAX_BATCH_SIZE,
  MAX_JOB_ATTEMPTS
} from "./job-policy";
import { files, jobs, uploadSessions, storageConnections } from "./db/schema";

export type JobRunOptions = {
  batchSize: number;
  leaseSeconds: number;
};

export type JobRunItem = {
  kind: "cleanup_multipart" | "purge_file" | "reconcile_usage" | "unknown";
  outcome: "completed" | "retrying" | "dead" | "lease_lost";
};

export type JobRunSummary = {
  ok: true;
  batchSize: number;
  leaseSeconds: number;
  claimed: number;
  completed: number;
  retrying: number;
  dead: number;
  leaseLost: number;
  jobs: JobRunItem[];
};

export class PermanentJobError extends Error {
  constructor() {
    super("Permanent job payload error");
    this.name = "PermanentJobError";
  }
}

const uuid = z.string().uuid();
const purgePayload = z.object({ ownerId: uuid, fileId: uuid });
const cleanupPayload = z.object({
  ownerId: uuid,
  uploadSessionId: uuid.optional(),
  sessionId: uuid.optional(),
  uploadId: uuid.optional()
});
const reconcilePayload = z.object({ ownerId: uuid });

function queryNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseJobRunOptions(request: Request): JobRunOptions {
  const params = new URL(request.url).searchParams;
  const batch = queryNumber(params.get("batch") ?? params.get("limit"));
  const lease = queryNumber(params.get("leaseSeconds") ?? params.get("lease"));
  return {
    batchSize: boundedBatchSize(batch),
    leaseSeconds: boundedLeaseSeconds(lease)
  };
}

export function bearerToken(value: string | null): string | null {
  const match = /^\s*Bearer\s+(\S+)\s*$/iu.exec(value ?? "");
  return match?.[1] ?? null;
}

export function isCronAuthorized(request: Request, expectedSecret: string | undefined): boolean {
  const presented = bearerToken(request.headers.get("authorization"));
  return Boolean(expectedSecret && presented && constantTimeEqual(presented, expectedSecret));
}

function permanentPayload(): never {
  throw new PermanentJobError();
}

async function processPurge(payload: unknown): Promise<void> {
  const parsed = purgePayload.safeParse(payload);
  if (!parsed.success) permanentPayload();
  // Recheck retention atomically: a restored/re-trashed file must not be
  // removed by an older queued cleanup job.
  const [staged] = await getDb().update(files).set({ status: "purge_pending", updatedAt: new Date() }).where(and(
    eq(files.ownerId, parsed.data.ownerId), eq(files.id, parsed.data.fileId),
    or(eq(files.status, "purge_pending"), and(eq(files.status, "trashed"), lte(files.trashedAt, trashCutoff())))
  )).returning();
  if (!staged) return;
  await deleteObject(staged.objectKey);
  // A concurrent retry may have finalized the row already; a null result is
  // therefore an idempotent success, not a reason to delete again.
  await finalizePurge(parsed.data.ownerId, parsed.data.fileId);
}

async function processMultipartCleanup(payload: unknown): Promise<void> {
  const parsed = cleanupPayload.safeParse(payload);
  if (!parsed.success) permanentPayload();
  const sessionId = parsed.data.uploadSessionId ?? parsed.data.sessionId ?? parsed.data.uploadId;
  if (!sessionId) permanentPayload();
  const prepared = await prepareExpiredUploadCleanup(parsed.data.ownerId, sessionId);
  if (!prepared.shouldCleanup) return;
  if (prepared.session.providerUploadId) {
    await abortMultipart(prepared.file.objectKey, prepared.session.providerUploadId);
  }
  await deleteObject(prepared.file.objectKey);
}

async function processUsageReconciliation(payload: unknown): Promise<void> {
  const parsed = reconcilePayload.safeParse(payload);
  if (!parsed.success) permanentPayload();
  await reconcileOwnerUsage(parsed.data.ownerId);
}

type JobRecord = typeof jobs.$inferSelect;

export async function processClaimedJob(job: JobRecord): Promise<void> {
  if (!isJobKind(job.kind)) permanentPayload();
  const ownerId = z.string().uuid().parse(job.payload.ownerId);
  if (job.kind === "reconcile_usage") {
    const connections = await getDb().select({ id: storageConnections.id }).from(storageConnections).where(and(eq(storageConnections.ownerId, ownerId), isNull(storageConnections.disconnectedAt)));
    for (const connection of connections) await withConnection(connection.id, ownerId, () => processUsageReconciliation(job.payload));
    return;
  }
  let id: string | undefined;
  if (job.kind === "purge_file") {
    const [file] = await getDb().select({ storageId: files.storageId }).from(files).where(and(eq(files.id, z.string().uuid().parse(job.payload.fileId)), eq(files.ownerId, ownerId)));
    id = file?.storageId;
  } else {
    const uploadId = z.string().uuid().parse(job.payload.uploadSessionId ?? job.payload.sessionId ?? job.payload.uploadId);
    const [upload] = await getDb().select({ storageId: uploadSessions.storageId }).from(uploadSessions).where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.ownerId, ownerId)));
    id = upload?.storageId;
  }
  if (!id) return;
  return withConnection(id, ownerId, () => job.kind === "purge_file" ? processPurge(job.payload) : processMultipartCleanup(job.payload));
}

function publicJobKind(value: string): JobRunItem["kind"] {
  return isJobKind(value) ? value : "unknown";
}

export async function runJobs(options: JobRunOptions): Promise<JobRunSummary> {
  const batchSize = Math.min(MAX_BATCH_SIZE, boundedBatchSize(options.batchSize));
  const leaseSeconds = boundedLeaseSeconds(options.leaseSeconds);
  const items: JobRunItem[] = [];
  let claimed = 0;
  let completed = 0;
  let retrying = 0;
  let dead = 0;
  let leaseLost = 0;
  const deadline = Date.now() + 45_000;

  for (let index = 0; index < batchSize; index += 1) {
    if (Date.now() >= deadline) break;
    const job = await claimNextJob(leaseSeconds);
    if (!job) break;
    claimed += 1;
    const kind = publicJobKind(job.kind);
    const expectedLeaseUntil = job.leaseUntil;
    try {
      await processClaimedJob(job);
      const finished = await completeJob(job.id, expectedLeaseUntil);
      if (!finished) {
        leaseLost += 1;
        items.push({ kind, outcome: "lease_lost" });
      } else {
        completed += 1;
        items.push({ kind, outcome: "completed" });
      }
    } catch (error) {
      const result = error instanceof PermanentJobError
        ? await deadLetterJob(job.id, error, expectedLeaseUntil)
        : await retryJob(job.id, error, MAX_JOB_ATTEMPTS, expectedLeaseUntil);
      if (!result) {
        leaseLost += 1;
        items.push({ kind, outcome: "lease_lost" });
      } else if (result.status === "dead") {
        dead += 1;
        items.push({ kind, outcome: "dead" });
      } else {
        retrying += 1;
        items.push({ kind, outcome: "retrying" });
      }
    }
  }

  return { ok: true, batchSize, leaseSeconds, claimed, completed, retrying, dead, leaseLost, jobs: items };
}
