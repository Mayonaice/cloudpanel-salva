import assert from "node:assert/strict";
import test from "node:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { auditEvents, files, folders, jobs, rateLimits, shares, uploadSessions, users, storageConnections } from "../src/lib/db/schema";

test("metadata schema exposes the control-plane source-of-truth tables", () => {
  for (const table of [users, folders, files, uploadSessions, shares, jobs, auditEvents, rateLimits, storageConnections]) {
    assert.equal(typeof table, "object");
    assert.ok(getTableName(table).startsWith("cloud_"));
    const config = getTableConfig(table);
    for (const index of config.indexes) assert.ok(index.config.name?.startsWith("cloud_"));
    for (const key of config.foreignKeys) assert.ok(key.getName().startsWith("cloud_"));
  }
  assert.equal(storageConnections["usedBytes" as keyof typeof storageConnections] !== undefined, true);
  assert.equal(files["objectKey" as keyof typeof files] !== undefined, true);
  assert.equal(uploadSessions["idempotencyKey" as keyof typeof uploadSessions] !== undefined, true);
  assert.equal(shares["tokenHash" as keyof typeof shares] !== undefined, true);
});
