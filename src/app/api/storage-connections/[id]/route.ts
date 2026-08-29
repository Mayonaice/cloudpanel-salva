import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { requireStorageAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { auditEvents, files, folders, jobs, storageConnections, users } from "@/lib/db/schema";
import { decryptCredentials, encryptCredentials } from "@/lib/credential-vault";
import { validateEndpoint } from "@/lib/endpoint-security";
import { handleRoute, readJson } from "@/lib/http";
import { assertSameOrigin, HttpError, jsonResponse, normalizeFileName } from "@/lib/security";
import { publicConnection, testCurrentConnection } from "@/lib/storage-connections";
import { withConnection, type StorageCredentials } from "@/lib/storage-context";
import { isStoredObjectKey } from "@/lib/bucket-key";
type Context = { params: Promise<{ id: string }> };
async function connectionId(context: Context) { const result = z.string().uuid().safeParse((await context.params).id); if (!result.success) throw new HttpError(400, "Invalid storage ID", "invalid_id"); return result.data; }
const patchSchema = z.object({
  connected: z.literal(true).optional(), name: z.string().trim().min(1).max(80).optional(), quotaBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  endpoint: z.string().url().optional(), bucket: z.string().trim().min(1).max(255).optional(), region: z.string().trim().min(1).max(80).optional(), prefix: z.string().max(500).optional(),
  accessKeyId: z.string().max(500).optional(), secretAccessKey: z.string().max(1000).optional(), forcePathStyle: z.boolean().optional(), token: z.string().max(1000).optional()
}).strict();
const forgetSchema = z.object({ confirmation: z.string().max(80) }).strict();
export async function POST(request: Request, context: Context) { return handleRoute(async () => { assertSameOrigin(request); const owner = await requireStorageAdmin(); return jsonResponse(await withConnection(await connectionId(context), owner.userId, testCurrentConnection)); }); }
export async function PATCH(request: Request, context: Context) {
  return handleRoute(async () => {
    assertSameOrigin(request); const owner = await requireStorageAdmin(); const id = await connectionId(context);
    const parsed = patchSchema.safeParse(await readJson(request)); if (!parsed.success) throw new HttpError(400, "Invalid storage settings", "invalid_input"); const body = parsed.data;
    const previous = await getDb().transaction(async tx => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, owner.userId)).for("update");
      const [existing] = await tx.select().from(storageConnections).where(and(eq(storageConnections.id, id), eq(storageConnections.ownerId, owner.userId)));
      if (!existing) throw new HttpError(404, "Storage not found", "storage_not_found");
      if (body.connected && existing.disconnectedAt) { const [count] = await tx.select({ count: sql<number>`count(*)` }).from(storageConnections).where(and(eq(storageConnections.ownerId, owner.userId), isNull(storageConnections.disconnectedAt), ne(storageConnections.id, id))); if (Number(count.count) >= 10) throw new HttpError(409, "Maximum of 10 active storage connections reached", "storage_limit"); }
      if (body.quotaBytes != null && body.quotaBytes < existing.usedBytes) throw new HttpError(409, "Capacity cannot be below current usage", "quota_below_usage");
      if (existing.kind !== "s3" && (body.bucket !== undefined || body.region !== undefined || body.prefix !== undefined || body.accessKeyId !== undefined || body.secretAccessKey !== undefined || body.forcePathStyle !== undefined)) throw new HttpError(400, "S3 fields cannot be used for this connection", "invalid_input");
      if (existing.kind === "s3" && body.token !== undefined) throw new HttpError(400, "Gateway token cannot be used for an S3 connection", "invalid_input");
      let prefix = existing.prefix;
      if (body.prefix !== undefined) { const clean = body.prefix.replace(/^\/+|\/+$/g, ""); if (clean && !isStoredObjectKey(clean)) throw new HttpError(400, "Invalid prefix", "invalid_prefix"); prefix = clean ? `${clean}/` : ""; if (prefix !== existing.prefix) { const [f] = await tx.select({ id: files.id }).from(files).where(eq(files.storageId, id)).limit(1); const [d] = await tx.select({ id: folders.id }).from(folders).where(eq(folders.storageId, id)).limit(1); if (f || d) throw new HttpError(409, "Prefix cannot change while indexed files or folders exist", "storage_not_empty"); } }
      const credentials = decryptCredentials<StorageCredentials>(existing.credentialsCiphertext, id);
      if (existing.kind === "s3") { if (body.accessKeyId) credentials.accessKeyId = body.accessKeyId; if (body.secretAccessKey) credentials.secretAccessKey = body.secretAccessKey; if (body.forcePathStyle !== undefined) credentials.forcePathStyle = body.forcePathStyle; }
      else if (body.token) { if (body.token.length < 32) throw new HttpError(400, "Gateway token must be at least 32 characters", "invalid_input"); credentials.token = body.token; }
      const endpoint = body.endpoint === undefined ? existing.endpoint : validateEndpoint(body.endpoint);
      await tx.update(storageConnections).set({ name: body.name === undefined ? existing.name : normalizeFileName(body.name), quotaBytes: body.quotaBytes === undefined ? existing.quotaBytes : body.quotaBytes, endpoint, bucket: existing.kind === "s3" ? body.bucket ?? existing.bucket : null, region: existing.kind === "s3" ? body.region ?? existing.region : null, prefix, credentialsCiphertext: encryptCredentials(credentials, id), ...(body.connected ? { disconnectedAt: null } : {}), updatedAt: new Date() }).where(eq(storageConnections.id, id));
      return existing;
    });
    const providerChanged = [body.endpoint, body.bucket, body.region, body.prefix, body.accessKeyId, body.secretAccessKey, body.forcePathStyle, body.token].some(value => value !== undefined && value !== "");
    if (body.connected || (providerChanged && previous.disconnectedAt === null)) {
      try { await withConnection(id, owner.userId, testCurrentConnection); }
      catch { await getDb().update(storageConnections).set({ name: previous.name, endpoint: previous.endpoint, bucket: previous.bucket, region: previous.region, prefix: previous.prefix, quotaBytes: previous.quotaBytes, credentialsCiphertext: previous.credentialsCiphertext, disconnectedAt: previous.disconnectedAt, updatedAt: new Date() }).where(and(eq(storageConnections.id, id), eq(storageConnections.ownerId, owner.userId))); throw new HttpError(400, "New settings failed the connection test; previous settings were restored", "storage_test_failed"); }
    }
    const [row] = await getDb().select().from(storageConnections).where(and(eq(storageConnections.id, id), eq(storageConnections.ownerId, owner.userId)));
    return jsonResponse({ connection: publicConnection(row) });
  });
}
export async function DELETE(request: Request, context: Context) {
  return handleRoute(async () => {
    assertSameOrigin(request); const owner = await requireStorageAdmin(); const id = await connectionId(context); const permanent = new URL(request.url).searchParams.get("permanent") === "1";
    if (!permanent) { const [row] = await getDb().update(storageConnections).set({ disconnectedAt: new Date(), updatedAt: new Date() }).where(and(eq(storageConnections.id, id), eq(storageConnections.ownerId, owner.userId))).returning(); if (!row) throw new HttpError(404, "Storage not found", "storage_not_found"); return jsonResponse({ disconnected: true, dataDeleted: false }); }
    const parsed = forgetSchema.safeParse(await readJson(request)); if (!parsed.success) throw new HttpError(400, "Type the storage name to confirm", "confirmation_required");
    const result = await getDb().transaction(async tx => { await tx.select({ id: users.id }).from(users).where(eq(users.id, owner.userId)).for("update"); const [row] = await tx.select().from(storageConnections).where(and(eq(storageConnections.id, id), eq(storageConnections.ownerId, owner.userId))); if (!row) throw new HttpError(404, "Storage not found", "storage_not_found"); if (!row.disconnectedAt) throw new HttpError(409, "Disconnect the storage before removing it", "disconnect_first"); if (parsed.data.confirmation !== row.name) throw new HttpError(400, "Storage name does not match", "confirmation_mismatch"); await tx.delete(jobs).where(sql`${jobs.payload}->>'storageId' = ${id}`); await tx.delete(storageConnections).where(eq(storageConnections.id, id)); await tx.insert(auditEvents).values({ ownerId: owner.userId, action: "storage_connection_removed", resourceType: "storage_connection", resourceId: id, metadata: { name: row.name, remoteDataDeleted: false } }); return row; });
    return jsonResponse({ removed: true, remoteDataDeleted: false, name: result.name });
  });
}
