import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { boundedLeaseSeconds, MAX_JOB_ATTEMPTS, retryDelayMs } from "./job-policy";
import { files, jobs, rateLimits, uploadSessions } from "./db/schema";
import { trashCutoff } from "./files";

export const JOB_KINDS = ["cleanup_multipart", "purge_file", "reconcile_usage"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

export async function enqueueJob(kind: JobKind, payload: Record<string, unknown>, availableAt = new Date()) {
  const [job] = await getDb().insert(jobs).values({ kind, payload, availableAt }).returning();
  return job;
}

/** Discover work from owned metadata; never enumerate storage to choose deletes. */
export async function enqueueMaintenanceJobs(now = new Date()) {
  return getDb().transaction(async (tx) => {
    // Coordinate overlapping cron invocations through the transaction pooler.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(191924747, 1)`);
    await tx.delete(rateLimits).where(lte(rateLimits.resetAt, now));
    const expired = await tx.select({ ownerId: uploadSessions.ownerId, uploadSessionId: uploadSessions.id }).from(uploadSessions)
      .where(and(lte(uploadSessions.expiresAt, now), sql`${uploadSessions.status} <> 'completed'`,
        sql`NOT EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobs.kind} = 'cleanup_multipart' AND ${jobs.payload}->>'uploadSessionId' = ${uploadSessions.id}::text)`)).limit(100);
    const pending = await tx.select({ ownerId: files.ownerId, fileId: files.id }).from(files)
      .where(and(or(eq(files.status, "purge_pending"), and(eq(files.status, "trashed"), lte(files.trashedAt, trashCutoff()))),
        sql`NOT EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobs.kind} = 'purge_file' AND ${jobs.payload}->>'fileId' = ${files.id}::text AND ${jobs.status} IN ('queued', 'leased', 'dead'))`)).limit(100);
    if (expired.length) await tx.insert(jobs).values(expired.map((payload) => ({ kind: "cleanup_multipart", payload, availableAt: now })));
    if (pending.length) await tx.insert(jobs).values(pending.map((payload) => ({ kind: "purge_file", payload, availableAt: now })));
    return { uploads: expired.length, purges: pending.length };
  });
}

/**
 * Claims one job with a short lease. The conditional update makes an expired
 * lease recoverable while preventing a second worker from taking a live job.
 */
export async function claimNextJob(leaseSeconds = 60) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const now = new Date();
    const [candidate] = await tx.select({ id: jobs.id }).from(jobs)
      .where(and(
        lte(jobs.availableAt, now),
        or(eq(jobs.status, "queued"), and(eq(jobs.status, "leased"), lte(jobs.leaseUntil, now)))
      ))
      .orderBy(asc(jobs.availableAt)).limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;

    const leaseUntil = new Date(now.getTime() + boundedLeaseSeconds(leaseSeconds) * 1000);
    const [claimed] = await tx.update(jobs).set({
      status: "leased",
      attempts: sql`${jobs.attempts} + 1`,
      leaseUntil,
      updatedAt: now
    }).where(and(
      eq(jobs.id, candidate.id),
      or(eq(jobs.status, "queued"), and(eq(jobs.status, "leased"), lte(jobs.leaseUntil, now)))
    )).returning();
    return claimed ?? null;
  });
}

export async function completeJob(jobId: string, expectedLeaseUntil?: Date | null) {
  const conditions = [eq(jobs.id, jobId), eq(jobs.status, "leased")];
  if (expectedLeaseUntil) conditions.push(eq(jobs.leaseUntil, expectedLeaseUntil));
  const [job] = await getDb().update(jobs).set({ status: "completed", leaseUntil: null, updatedAt: new Date() })
    .where(and(...conditions)).returning();
  return job ?? null;
}

export async function retryJob(jobId: string, error: unknown, maxAttempts = MAX_JOB_ATTEMPTS, expectedLeaseUntil?: Date | null) {
  const conditions = [eq(jobs.id, jobId), eq(jobs.status, "leased")];
  if (expectedLeaseUntil) conditions.push(eq(jobs.leaseUntil, expectedLeaseUntil));
  const [current] = await getDb().select({ attempts: jobs.attempts }).from(jobs).where(and(...conditions)).limit(1);
  if (!current) return null;
  const boundedMaxAttempts = Number.isSafeInteger(maxAttempts) ? Math.max(1, Math.min(32, maxAttempts)) : MAX_JOB_ATTEMPTS;
  const dead = current.attempts >= boundedMaxAttempts;
  const safeError = error instanceof Error ? error.name.slice(0, 120) : "unknown_error";
  const delayMs = retryDelayMs(current.attempts);
  const updateConditions = [eq(jobs.id, jobId), eq(jobs.status, "leased")];
  if (expectedLeaseUntil) updateConditions.push(eq(jobs.leaseUntil, expectedLeaseUntil));
  const [job] = await getDb().update(jobs).set({
    status: dead ? "dead" : "queued",
    leaseUntil: null,
    availableAt: new Date(Date.now() + delayMs),
    lastError: safeError,
    updatedAt: new Date()
  }).where(and(...updateConditions)).returning();
  return job ?? null;
}

export async function deadLetterJob(jobId: string, error: unknown, expectedLeaseUntil?: Date | null) {
  const conditions = [eq(jobs.id, jobId), eq(jobs.status, "leased")];
  if (expectedLeaseUntil) conditions.push(eq(jobs.leaseUntil, expectedLeaseUntil));
  const safeError = error instanceof Error ? error.name.slice(0, 120) : "permanent_job_error";
  const [job] = await getDb().update(jobs).set({
    status: "dead",
    leaseUntil: null,
    lastError: safeError,
    updatedAt: new Date()
  }).where(and(...conditions)).returning();
  return job ?? null;
}
