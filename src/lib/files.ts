import { tenantScope, storageId } from "./storage-context";
import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { auditEvents, files, folders, uploadSessions, users, storageConnections } from "./db/schema";
import { getEnv } from "./env";
import { HttpError, normalizeFileName } from "./security";
import type { UploadState } from "./state";
import { namedObjectKey, resolveFolderPath } from "./storage-path";
import { createFolderMarker, storedObjectExists } from "./storage";

export async function listFiles(ownerId: string, folderId: string | null, search?: string, includeTrash = false) {
  const conditions = [tenantScope(files, ownerId)];
  if (includeTrash) conditions.push(inArray(files.status, ["trashed", "purge_pending"] as const));
  else conditions.push(isNull(files.trashedAt), inArray(files.status, ["uploading", "ready"] as const));
  // Trash is a single cross-folder view. Active files remain scoped to the
  // requested folder (or the root when no folder is selected).
  if (!includeTrash) {
    if (folderId) conditions.push(eq(files.folderId, folderId));
    else conditions.push(isNull(files.folderId));
  }
  if (search?.trim()) conditions.push(ilike(files.name, `%${search.trim().slice(0, 120)}%`));
  return getDb().select({
    id: files.id,
    name: files.name,
    contentType: files.contentType,
    sizeBytes: files.sizeBytes,
    status: files.status,
    folderId: files.folderId,
    createdAt: files.createdAt,
    updatedAt: files.updatedAt
  }).from(files).where(and(...conditions)).orderBy(desc(files.updatedAt)).limit(200);
}

export async function listFolders(ownerId: string, parentId: string | null) {
  return getDb().select({ id: folders.id, name: folders.name, parentId: folders.parentId, updatedAt: folders.updatedAt })
    .from(folders).where(and(tenantScope(folders, ownerId), parentId ? eq(folders.parentId, parentId) : isNull(folders.parentId)))
    .orderBy(folders.name).limit(200);
}

export function toPublicFile(file: {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  status: string;
  folderId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: file.id,
    name: file.name,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    folderId: file.folderId,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt
  };
}

export async function getOwnedFile(ownerId: string, fileId: string) {
  const [file] = await getDb().select().from(files).where(and(tenantScope(files, ownerId), eq(files.id, fileId))).limit(1);
  if (!file) throw new HttpError(404, "File not found", "file_not_found");
  return file;
}

export async function reserveUpload(input: {
  ownerId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  objectKey?: string;
  folderId?: string | null;
  idempotencyKey: string;
}) {
  const db = getDb();
  return db.transaction(async (tx) => {
    // Serialize owner mutations before checking idempotency or changing quota.
    const [lockedOwner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.ownerId)).for("update");
    if (!lockedOwner) throw new HttpError(401, "Owner account not found", "owner_not_found");
    const [existing] = await tx.select({ session: uploadSessions, file: files }).from(uploadSessions)
      .innerJoin(files, eq(files.id, uploadSessions.fileId))
      .where(and(tenantScope(uploadSessions, input.ownerId), eq(uploadSessions.idempotencyKey, input.idempotencyKey))).limit(1);
    if (existing) {
      const sameRequest = existing.file.name === input.name
        && existing.file.contentType === input.contentType
        && existing.file.sizeBytes === input.sizeBytes
        && (existing.file.folderId ?? null) === (input.folderId ?? null);
      if (!sameRequest) throw new HttpError(409, "Idempotency key was already used for another upload", "idempotency_conflict");
      if (existing.file.status === "purged" || existing.session.status === "aborted" || existing.session.status === "failed") {
        throw new HttpError(409, "This upload session is no longer open; retry with a new idempotency key", "idempotency_terminal");
      }
      if (existing.session.status !== "completed" && existing.session.expiresAt.getTime() <= Date.now()) {
        throw new HttpError(409, "Upload session expired", "upload_expired");
      }
      return { session: existing.session, file: existing.file, reused: true };
    }

    const [owner] = await tx.select().from(users).where(eq(users.id, input.ownerId)).limit(1);
    if (!owner) throw new HttpError(401, "Owner account not found", "owner_not_found");
    if (input.folderId) {
      const [folder] = await tx.select({ id: folders.id }).from(folders)
        .where(and(eq(folders.id, input.folderId), tenantScope(folders, input.ownerId))).limit(1);
      if (!folder) throw new HttpError(404, "Destination folder not found", "folder_not_found");
    }
    const fileId = randomUUID();
    let objectKey = input.objectKey;
    if (!objectKey) {
      const ownedFolders = await tx.select().from(folders).where(tenantScope(folders, input.ownerId));
      const prefix = resolveFolderPath(ownedFolders, input.folderId ?? null);
      if (prefix) await createFolderMarker(prefix);
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = namedObjectKey(prefix, input.name, attempt ? randomUUID().slice(0, 8) : undefined);
        const [known] = await tx.select({ id: files.id }).from(files).where(and(eq(files.storageId, storageId()), eq(files.objectKey, candidate))).limit(1);
        if (!known && !(await storedObjectExists(candidate))) { objectKey = candidate; break; }
      }
      if (!objectKey) throw new HttpError(409, "Could not allocate a unique file name", "name_conflict");
    }
    const sessionId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    // Reserve quota atomically. A read-then-write check would allow concurrent
    // uploads to oversubscribe the owner's quota.
    const [reservedOwner] = await tx.update(storageConnections)
      .set({ usedBytes: sql`${storageConnections.usedBytes} + ${input.sizeBytes}`, updatedAt: now })
      .where(and(eq(storageConnections.id, storageId()), sql`(${storageConnections.quotaBytes} IS NULL OR ${storageConnections.usedBytes} + ${input.sizeBytes} <= ${storageConnections.quotaBytes})`))
      .returning({ id: storageConnections.id });
    if (!reservedOwner) throw new HttpError(413, "Storage quota exceeded", "quota_exceeded");
    const [file] = await tx.insert(files).values({ storageId: storageId(),
      id: fileId,
      ownerId: input.ownerId,
      folderId: input.folderId ?? null,
      name: input.name,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      objectKey,
      status: "uploading"
    }).returning();
    const [session] = await tx.insert(uploadSessions).values({ storageId: storageId(),
      id: sessionId,
      ownerId: input.ownerId,
      fileId,
      idempotencyKey: input.idempotencyKey,
      status: "initiated",
      reservedBytes: input.sizeBytes,
      expiresAt
    }).returning();
    await tx.insert(auditEvents).values({ ownerId: input.ownerId, action: "upload_reserved", resourceType: "file", resourceId: fileId, metadata: { sizeBytes: input.sizeBytes } });
    return { session, file, reused: false };
  });
}

export async function setUploadProviderId(ownerId: string, sessionId: string, providerUploadId: string) {
  const [session] = await getDb().update(uploadSessions).set({ providerUploadId, status: "uploading", updatedAt: new Date() })
    .where(and(
      tenantScope(uploadSessions, ownerId),
      eq(uploadSessions.id, sessionId),
      isNull(uploadSessions.providerUploadId),
      inArray(uploadSessions.status, ["initiated", "uploading"] as const)
    )).returning();
  if (!session) {
    const current = await getOwnedUpload(ownerId, sessionId);
    if (current.session.providerUploadId && current.session.status === "uploading") return current.session;
    throw new HttpError(409, "Upload state changed", "upload_state_conflict");
  }
  return session;
}

export async function getOwnedUpload(ownerId: string, sessionId: string) {
  const [result] = await getDb().select({ session: uploadSessions, file: files }).from(uploadSessions)
    .innerJoin(files, eq(files.id, uploadSessions.fileId))
    .where(and(tenantScope(uploadSessions, ownerId), eq(uploadSessions.id, sessionId))).limit(1);
  if (!result) throw new HttpError(404, "Upload session not found", "upload_not_found");
  return result;
}

export async function markUploadCompleting(ownerId: string, sessionId: string) {
  const [session] = await getDb().update(uploadSessions).set({ status: "completing", updatedAt: new Date() })
    .where(and(tenantScope(uploadSessions, ownerId), eq(uploadSessions.id, sessionId), inArray(uploadSessions.status, ["initiated", "uploading", "completing"] as const))).returning();
  if (!session) throw new HttpError(409, "Upload cannot be completed from its current state", "upload_state_conflict");
  return session;
}

export async function finalizeUpload(ownerId: string, sessionId: string, checksumSha256?: string | null) {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for("update");
    const [current] = await tx.select({ session: uploadSessions, file: files }).from(uploadSessions)
      .innerJoin(files, eq(files.id, uploadSessions.fileId))
      .where(and(tenantScope(uploadSessions, ownerId), eq(uploadSessions.id, sessionId))).limit(1);
    if (!current) throw new HttpError(404, "Upload session not found", "upload_not_found");
    if (current.session.status === "completed") return current.file;
    if (current.session.status !== "completing") throw new HttpError(409, "Upload is not ready to finalize", "upload_state_conflict");
    const [file] = await tx.update(files).set({ status: "ready", checksumSha256: checksumSha256 ?? null, updatedAt: new Date() })
      .where(and(eq(files.id, current.file.id), tenantScope(files, ownerId), eq(files.status, "uploading"))).returning();
    if (!file) throw new HttpError(409, "File state changed while completing", "file_state_conflict");
    await tx.update(uploadSessions).set({ status: "completed", updatedAt: new Date() }).where(eq(uploadSessions.id, sessionId));
    await tx.insert(auditEvents).values({ ownerId, action: "upload_completed", resourceType: "file", resourceId: file.id, metadata: {} });
    return file;
  });
}

export async function failOrAbortUpload(ownerId: string, sessionId: string, state: Extract<UploadState, "aborted" | "failed"> = "aborted") {
  return prepareExpiredUploadCleanup(ownerId, sessionId, new Date(), { force: true, state });
}

const cleanupUploadStates = ["initiated", "uploading", "completing"] as const;
type CleanupUploadState = (typeof cleanupUploadStates)[number];

function isCleanupUploadState(status: string): status is CleanupUploadState {
  return (cleanupUploadStates as readonly string[]).includes(status);
}

/**
 * Atomically claims an expired upload for provider cleanup. The metadata
 * transition happens before the provider call so a concurrent completion
 * cannot turn a cleanup retry into a deletion of a ready file. If the
 * provider call fails, a later retry can safely repeat the idempotent abort
 * and delete operations against the already-aborted session.
 */
export async function prepareExpiredUploadCleanup(ownerId: string, sessionId: string, now = new Date(), options: { force?: boolean; state?: "aborted" | "failed" } = {}) {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for("update");
    const selectUpload = () => tx.select({ session: uploadSessions, file: files }).from(uploadSessions)
      .innerJoin(files, eq(files.id, uploadSessions.fileId))
      .where(and(
        tenantScope(uploadSessions, ownerId),
        eq(uploadSessions.id, sessionId),
        tenantScope(files, ownerId)
      )).limit(1);
    const [current] = await selectUpload();
    if (!current) throw new HttpError(404, "Upload session not found", "upload_not_found");
    if (current.session.status === "completed") return { ...current, shouldCleanup: false };
    if (!options.force && isCleanupUploadState(current.session.status) && current.session.expiresAt.getTime() > now.getTime()) {
      return { ...current, shouldCleanup: false };
    }

    if (isCleanupUploadState(current.session.status)) {
      // Only an upload-owned object may be removed by this job. If metadata
      // already moved the file into the normal file lifecycle, leave it for
      // that lifecycle's worker instead of deleting a ready/trash object.
      if (current.file.status === "purged") return { ...current, shouldCleanup: true };
      if (current.file.status !== "uploading") return { ...current, shouldCleanup: false };
      // Transition the file first. Completion follows the same file-first
      // ordering, so a completion that wins this race leaves no path to a
      // provider deletion of a ready object.
      const [purgedFile] = await tx.update(files).set({ status: "purged", purgedAt: now, updatedAt: now })
        .where(and(
          tenantScope(files, ownerId),
          eq(files.id, current.file.id),
          eq(files.status, "uploading"),
          isNull(files.purgedAt)
        )).returning();
      if (!purgedFile) {
        const [latest] = await selectUpload();
        if (!latest) throw new HttpError(404, "Upload session not found", "upload_not_found");
        if (latest.session.status === "completed" || latest.file.status === "ready") return { ...latest, shouldCleanup: false };
        if (latest.session.status === "aborted" || latest.session.status === "failed" || latest.file.status === "purged") {
          return { ...latest, shouldCleanup: true };
        }
        throw new Error("upload_state_changed");
      }

      const [changed] = await tx.update(uploadSessions).set({ status: options.state ?? "aborted", updatedAt: now })
        .where(and(
          tenantScope(uploadSessions, ownerId),
          eq(uploadSessions.id, sessionId),
          inArray(uploadSessions.status, cleanupUploadStates)
        )).returning();
      if (!changed) {
        const [latest] = await selectUpload();
        if (!latest) throw new HttpError(404, "Upload session not found", "upload_not_found");
        if (latest.session.status === "completed" || latest.file.status === "ready") return { ...latest, shouldCleanup: false };
        if (latest.session.status === "aborted" || latest.session.status === "failed" || latest.file.status === "purged") {
          return { ...latest, shouldCleanup: true };
        }
        throw new Error("upload_state_changed");
      }

      await tx.update(storageConnections).set({
        usedBytes: sql`GREATEST(${storageConnections.usedBytes} - ${current.session.reservedBytes}, 0)`,
        updatedAt: now
      }).where(eq(storageConnections.id, storageId()));
      await tx.insert(auditEvents).values({ ownerId, action: "upload_cleanup_claimed", resourceType: "file", resourceId: current.file.id, metadata: {} });
      return { session: changed, file: purgedFile, shouldCleanup: true };
    }

    // Aborted/failed sessions may still have an orphaned provider object if a
    // prior invocation died after the DB transition. Repeating cleanup is
    // safe and is required for eventual removal.
    if (current.file.status !== "uploading" && current.file.status !== "purged") {
      return { ...current, shouldCleanup: false };
    }
    return { ...current, shouldCleanup: true };
  });
}

export async function updateOwnedFile(ownerId: string, fileId: string, changes: { name?: string; folderId?: string | null }) {
  if (changes.folderId !== undefined && changes.folderId !== null) {
    const [folder] = await getDb().select({ id: folders.id }).from(folders)
      .where(and(tenantScope(folders, ownerId), eq(folders.id, changes.folderId))).limit(1);
    if (!folder) throw new HttpError(404, "Destination folder not found", "folder_not_found");
  }
  const safeChanges = { ...changes, name: changes.name === undefined ? undefined : normalizeFileName(changes.name) };
  const [file] = await getDb().update(files).set({ ...safeChanges, updatedAt: new Date() })
    .where(and(tenantScope(files, ownerId), eq(files.id, fileId), inArray(files.status, ["ready", "trashed"] as const))).returning();
  if (!file) throw new HttpError(404, "File not found", "file_not_found");
  return file;
}

export async function trashOwnedFile(ownerId: string, fileId: string) {
  const db = getDb();
  const [file] = await db.update(files).set({ status: "trashed", trashedAt: new Date(), updatedAt: new Date() })
    .where(and(tenantScope(files, ownerId), eq(files.id, fileId), eq(files.status, "ready"))).returning();
  if (!file) throw new HttpError(404, "File not found or already trashed", "file_not_found");
  await db.insert(auditEvents).values({ ownerId, action: "file_trashed", resourceType: "file", resourceId: file.id, metadata: {} });
  return file;
}

export async function restoreOwnedFile(ownerId: string, fileId: string) {
  const db = getDb();
  const [file] = await db.update(files).set({ status: "ready", trashedAt: null, updatedAt: new Date() })
    .where(and(tenantScope(files, ownerId), eq(files.id, fileId), eq(files.status, "trashed"))).returning();
  if (!file) throw new HttpError(404, "Trashed file not found", "file_not_found");
  await db.insert(auditEvents).values({ ownerId, action: "file_restored", resourceType: "file", resourceId: file.id, metadata: {} });
  return file;
}

export async function stagePurge(ownerId: string, fileId: string) {
  const [file] = await getDb().update(files).set({ status: "purge_pending", updatedAt: new Date() })
    .where(and(tenantScope(files, ownerId), eq(files.id, fileId), inArray(files.status, ["trashed", "purge_pending"] as const), isNull(files.purgedAt))).returning();
  if (!file) {
    const existing = await getOwnedFile(ownerId, fileId);
    if (existing.status === "purged") return { file: existing, alreadyPurged: true };
    throw new HttpError(409, "File is not ready to purge", "purge_state_conflict");
  }
  return { file, alreadyPurged: false };
}

export async function finalizePurge(ownerId: string, fileId: string) {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for("update");
    const [file] = await tx.update(files).set({ status: "purged", purgedAt: new Date(), updatedAt: new Date() })
      .where(and(tenantScope(files, ownerId), eq(files.id, fileId), eq(files.status, "purge_pending"), isNull(files.purgedAt))).returning();
    if (!file) return null;
    await tx.update(storageConnections).set({ usedBytes: sql`GREATEST(${storageConnections.usedBytes} - ${file.sizeBytes}, 0)`, updatedAt: new Date() }).where(eq(storageConnections.id, storageId()));
    await tx.insert(auditEvents).values({ ownerId, action: "file_purged", resourceType: "file", resourceId: file.id, metadata: {} });
    return file;
  });
}

/** Recompute quota from metadata; purged files never contribute to usage. */
export async function reconcileOwnerUsage(ownerId: string) {
  const db = getDb();
  return db.transaction(async (tx) => {
    // Reserve/finalize paths lock the owner row while changing used_bytes;
    // taking the same lock prevents reconciliation from overwriting a
    // concurrent quota mutation with a stale sum.
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).limit(1).for("update");
    if (!owner) throw new HttpError(404, "Owner account not found", "owner_not_found");
    const [total] = await tx.select({ usedBytes: sql<string>`COALESCE(SUM(${files.sizeBytes}), 0)` })
      .from(files)
      .where(and(tenantScope(files, ownerId), inArray(files.status, ["uploading", "ready", "trashed", "purge_pending"] as const)));
    const usedBytes = Number(total?.usedBytes ?? 0);
    if (!Number.isSafeInteger(usedBytes) || usedBytes < 0) throw new Error("usage_out_of_range");
    const [updated] = await tx.update(storageConnections).set({ usedBytes, updatedAt: new Date() })
      .where(eq(storageConnections.id, storageId())).returning({ usedBytes: storageConnections.usedBytes });
    return { ownerId, usedBytes: Number(updated?.usedBytes ?? usedBytes) };
  });
}

export async function getQuota(ownerId: string) {
  const [owner] = await getDb().select({ quotaBytes: storageConnections.quotaBytes, usedBytes: storageConnections.usedBytes })
    .from(storageConnections).where(and(eq(storageConnections.id, storageId()), eq(storageConnections.ownerId, ownerId))).limit(1);
  if (!owner) throw new HttpError(404, "Owner account not found", "owner_not_found");
  return owner;
}

export function trashCutoff(): Date {
  return new Date(Date.now() - getEnv().TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}
