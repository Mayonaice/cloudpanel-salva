import { isStoredObjectKey } from "./bucket-key";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "./db";
import { storageConnections, users } from "./db/schema";
import { encryptCredentials } from "./credential-vault";
import { validateEndpoint } from "./endpoint-security";
import { withConnection, currentStorage, connectionClient } from "./storage-context";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { nasControl } from "./nas-provider";
import { HttpError, normalizeFileName } from "./security";

export const createConnectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("s3"), name: z.string().min(1).max(80), endpoint: z.string().url(), bucket: z.string().min(1).max(255), region: z.string().min(1).max(80).default("auto"), prefix: z.string().max(500).default(""), accessKeyId: z.string().min(1).max(500), secretAccessKey: z.string().min(1).max(1000), forcePathStyle: z.boolean().default(true), quotaBytes: z.number().int().positive().nullable().optional() }),
  z.object({ kind: z.literal("nas"), name: z.string().min(1).max(80), endpoint: z.string().url(), token: z.string().min(32).max(1000), quotaBytes: z.number().int().positive().nullable().optional() }),
  z.object({ kind: z.literal("webdav"), name: z.string().min(1).max(80), endpoint: z.string().url(), token: z.string().min(32).max(1000), quotaBytes: z.number().int().positive().nullable().optional() })
]);
export type CreateConnection = z.infer<typeof createConnectionSchema>;
export function publicConnection(connection: typeof storageConnections.$inferSelect) {
  return { id: connection.id, name: connection.name, kind: connection.kind, endpoint: connection.endpoint, bucket: connection.bucket, region: connection.region, prefix: connection.prefix, quotaBytes: connection.quotaBytes, usedBytes: connection.usedBytes, connected: !connection.disconnectedAt, checkedAt: connection.checkedAt, createdAt: connection.createdAt };
}
export async function listConnections(ownerId: string) {
  return (await getDb().select().from(storageConnections).where(eq(storageConnections.ownerId, ownerId)).orderBy(sql`${storageConnections.disconnectedAt} nulls first`, desc(storageConnections.createdAt))).map(publicConnection);
}
export async function testCurrentConnection() {
  const { connection } = currentStorage();
  if (connection.kind === "s3") await connectionClient().send(new HeadBucketCommand({ Bucket: connection.bucket! }));
  else { const health = await nasControl<{ protocol?: string }>("health"); const expected = connection.kind === "webdav" ? "cloud-webdav-gateway-v1" : "cloud-nas-v1"; if (health.protocol !== expected) throw new HttpError(400, `Endpoint is not a compatible ${connection.kind === "webdav" ? "Salva Transfer Gateway" : "NAS agent"}`, "storage_protocol_invalid"); }
  await getDb().update(storageConnections).set({ checkedAt: new Date(), updatedAt: new Date() }).where(eq(storageConnections.id, connection.id));
  return { ok: true, checkedAt: new Date().toISOString() };
}
export async function createConnection(ownerId: string, input: CreateConnection) {
  const id = randomUUID();
  const endpoint = validateEndpoint(input.endpoint);
  const name = normalizeFileName(input.name);
  const prefix = input.kind === "s3" ? input.prefix.replace(/^\/+|\/+$/g, "") : "";
  if (prefix && !isStoredObjectKey(prefix)) throw new HttpError(400, "Invalid prefix", "invalid_prefix");
  const credentialsCiphertext = encryptCredentials(input.kind === "s3" ? { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey, forcePathStyle: input.forcePathStyle } : { token: input.token }, id);
  const [created] = await getDb().transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for("update");
  const count = await tx.select({ count: sql<number>`count(*)` }).from(storageConnections).where(and(eq(storageConnections.ownerId, ownerId), isNull(storageConnections.disconnectedAt)));
  if (Number(count[0]?.count ?? 0) >= 10) throw new HttpError(409, "Maximum of 10 active storage connections reached", "storage_limit");
    return tx.insert(storageConnections).values({ id, ownerId, name, kind: input.kind, endpoint, bucket: input.kind === "s3" ? input.bucket : null, region: input.kind === "s3" ? input.region : null, prefix: prefix ? prefix + "/" : "", credentialsCiphertext, quotaBytes: input.quotaBytes ?? null }).returning();
  });
  try { await withConnection(id, ownerId, testCurrentConnection); }
  catch (error) { await getDb().delete(storageConnections).where(and(eq(storageConnections.id, id), eq(storageConnections.ownerId, ownerId))); throw new HttpError(400, error instanceof HttpError ? error.message : "Storage connection test failed", "storage_test_failed"); }
  return publicConnection(created);
}
