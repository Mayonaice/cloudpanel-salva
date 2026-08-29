import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, isNull, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { S3Client } from "@aws-sdk/client-s3";
import { getDb } from "./db";
import { storageConnections } from "./db/schema";
import { decryptCredentials } from "./credential-vault";
import { publicHttpsAgent, validateEndpoint } from "./endpoint-security";
import { HttpError } from "./security";

export type StorageConnection = typeof storageConnections.$inferSelect;
export type StorageCredentials = { accessKeyId?: string; secretAccessKey?: string; token?: string; forcePathStyle?: boolean };
type Context = { connection: StorageConnection; credentials: StorageCredentials; client?: S3Client };
const context = new AsyncLocalStorage<Context>();
export function currentStorage() {
  const value = context.getStore();
  if (!value) throw new HttpError(400, "Select a storage connection first", "storage_required");
  return value;
}
export function storageId() { return currentStorage().connection.id; }
export function tenantScope(table: { ownerId: AnyPgColumn; storageId: AnyPgColumn }, ownerId: string): SQL {
  const scope = currentStorage();
  if (scope.connection.ownerId !== ownerId) throw new HttpError(404, "Storage not found", "storage_not_found");
  return and(eq(table.ownerId, ownerId), eq(table.storageId, scope.connection.id))!;
}
export async function withConnection<T>(id: string, ownerId: string, operation: () => Promise<T>): Promise<T> {
  const [connection] = await getDb().select().from(storageConnections).where(and(eq(storageConnections.id, id), eq(storageConnections.ownerId, ownerId), isNull(storageConnections.disconnectedAt))).limit(1);
  if (!connection) throw new HttpError(404, "Storage connection not found or disconnected", "storage_not_found");
  validateEndpoint(connection.endpoint);
  const credentials = decryptCredentials<StorageCredentials>(connection.credentialsCiphertext, connection.id);
  const scope: Context = { connection, credentials };
  try { return await context.run(scope, operation); }
  finally { scope.client?.destroy(); }
}
export function connectionClient() {
  const scope = currentStorage();
  if (scope.connection.kind !== "s3") throw new Error("S3 operation requested on a non-S3 connection");
  scope.client ??= new S3Client({ endpoint: scope.connection.endpoint, region: scope.connection.region ?? "auto", forcePathStyle: scope.credentials.forcePathStyle ?? true, credentials: { accessKeyId: scope.credentials.accessKeyId!, secretAccessKey: scope.credentials.secretAccessKey! }, requestChecksumCalculation: "WHEN_REQUIRED", requestHandler: { httpsAgent: publicHttpsAgent(), connectionTimeout: 8000, requestTimeout: 20000 } });
  return scope.client;
}
