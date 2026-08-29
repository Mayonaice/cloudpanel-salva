import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { closeDb, getDb } from "../src/lib/db";
import { users, storageConnections, files, folders, auditEvents } from "../src/lib/db/schema";
import { encryptCredentials } from "../src/lib/credential-vault";
import { withConnection } from "../src/lib/storage-context";
import { getOwnedFile, getQuota, listFiles, reserveUpload, updateOwnedFile } from "../src/lib/files";

test("users and storage connections cannot cross file, folder or quota boundaries", { skip: process.env.DATABASE_INTEGRATION_TEST !== "true" }, async () => {
  const db = getDb(); const owners = [randomUUID(), randomUUID()];
  const connections = [randomUUID(), randomUUID(), randomUUID()];
  try {
    for (const id of owners) await db.insert(users).values({ id, googleSubject: `tenant-${id}`, email: `${id}@example.invalid`, displayName: "Tenant fixture" });
    for (const [index, id] of connections.entries()) await db.insert(storageConnections).values({ id, ownerId: index < 2 ? owners[0] : owners[1], kind: "s3", name: "Isolation fixture", endpoint: "https://storage.example.test", credentialsCiphertext: encryptCredentials({}, id), quotaBytes: 100 });
    const [folder] = await db.insert(folders).values({ ownerId: owners[0], storageId: connections[0], name: "private" }).returning();
    const [file] = await db.insert(files).values({ ownerId: owners[0], storageId: connections[0], folderId: folder.id, name: "private.txt", contentType: "text/plain", objectKey: `fixture-${randomUUID()}`, sizeBytes: 10, status: "ready" }).returning();
    await assert.rejects(() => withConnection(connections[0], owners[1], async () => {}));
    await withConnection(connections[2], owners[1], async () => {
      assert.equal((await listFiles(owners[1], null)).length, 0);
      await assert.rejects(() => getOwnedFile(owners[1], file.id));
      await assert.rejects(() => reserveUpload({ ownerId: owners[1], folderId: folder.id, name: "x", contentType: "text/plain", sizeBytes: 1, objectKey: "test-key", idempotencyKey: randomUUID() }));
    });
    await withConnection(connections[1], owners[0], async () => {
      await assert.rejects(() => getOwnedFile(owners[0], file.id));
      await assert.rejects(() => updateOwnedFile(owners[0], file.id, { name: "stolen" }));
      assert.equal((await getQuota(owners[0])).usedBytes, 0);
      await reserveUpload({ ownerId: owners[0], name: "same-key.txt", contentType: "text/plain", sizeBytes: 25, objectKey: file.objectKey, idempotencyKey: randomUUID() });
      assert.equal((await getQuota(owners[0])).usedBytes, 25);
      await assert.rejects(() => reserveUpload({ ownerId: owners[0], name: "too-large", contentType: "text/plain", sizeBytes: 90, objectKey: randomUUID(), idempotencyKey: randomUUID() }));
    });
    await withConnection(connections[0], owners[0], async () => { assert.equal((await getQuota(owners[0])).usedBytes, 0); assert.equal((await getOwnedFile(owners[0], file.id)).name, "private.txt"); });
    await db.update(storageConnections).set({ disconnectedAt: new Date() }).where(eq(storageConnections.id, connections[0]));
    await assert.rejects(() => withConnection(connections[0], owners[0], async () => {}));
  } finally {
    await db.delete(auditEvents).where(inArray(auditEvents.ownerId, owners));
    await db.delete(users).where(inArray(users.id, owners));
    await closeDb();
  }
});
