import { withConnection } from "../src/lib/storage-context";
import { encryptCredentials } from "../src/lib/credential-vault";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../src/lib/db";
import { auditEvents, jobs, rateLimits, uploadSessions, users, storageConnections } from "../src/lib/db/schema";
import { consumeSharedRateLimit } from "../src/lib/rate-limit";
import { enqueueMaintenanceJobs } from "../src/lib/jobs";
import { sql } from "drizzle-orm";
import { failOrAbortUpload, finalizeUpload, getOwnedUpload, getQuota, markUploadCompleting, prepareExpiredUploadCleanup, reserveUpload } from "../src/lib/files";

test("database upload races preserve file state and release quota once", { skip: process.env.DATABASE_INTEGRATION_TEST !== "true" }, async () => {
  const db = getDb();
  const ownerId = randomUUID();
  try {
    await db.insert(users).values({ id: ownerId, googleSubject: `integration-${ownerId}`, email: `${ownerId}@example.invalid`, displayName: "Integration fixture" });
    const storageId = randomUUID();
    await db.insert(storageConnections).values({ id: storageId, ownerId, name: "DB fixture", kind: "s3", endpoint: "https://storage.example.test", credentialsCiphertext: encryptCredentials({}, storageId), quotaBytes: 20000000000 });
    await withConnection(storageId, ownerId, async () => {
    const input = { ownerId, name: "fixture.txt", contentType: "text/plain", sizeBytes: 10, objectKey: randomUUID().replaceAll("-", ""), idempotencyKey: randomUUID() };
    const reservations = await Promise.all([reserveUpload(input), reserveUpload(input)]);
    assert.equal(reservations[0].session.id, reservations[1].session.id);
    assert.equal((await getQuota(ownerId)).usedBytes, 10);
    const id = reservations[0].session.id;
    assert.equal((await prepareExpiredUploadCleanup(ownerId, id)).shouldCleanup, false);
    await markUploadCompleting(ownerId, id);
    await Promise.allSettled([finalizeUpload(ownerId, id), failOrAbortUpload(ownerId, id)]);
    const current = await getOwnedUpload(ownerId, id);
    if (current.session.status === "completed") {
      assert.equal(current.file.status, "ready");
      assert.equal((await failOrAbortUpload(ownerId, id)).shouldCleanup, false);
      assert.equal((await getQuota(ownerId)).usedBytes, 10);
    } else {
      assert.equal(current.file.status, "purged");
      assert.equal((await getQuota(ownerId)).usedBytes, 0);
    }
    const next = await reserveUpload({ ...input, objectKey: randomUUID().replaceAll("-", ""), idempotencyKey: randomUUID() });
    const before = (await getQuota(ownerId)).usedBytes;
    await Promise.all([failOrAbortUpload(ownerId, next.session.id), failOrAbortUpload(ownerId, next.session.id)]);
    assert.equal((await getQuota(ownerId)).usedBytes, before - 10);
    await assert.rejects(() => finalizeUpload(ownerId, next.session.id));
    await db.update(uploadSessions).set({ expiresAt: new Date(0) }).where(eq(uploadSessions.id, next.session.id));
    await Promise.all([enqueueMaintenanceJobs(), enqueueMaintenanceJobs()]);
    const cleanup = await db.select().from(jobs).where(sql`${jobs.payload}->>'uploadSessionId' = ${next.session.id}`);
    assert.equal(cleanup.length, 1);
    const attempts = await Promise.all(Array.from({ length: 8 }, () => consumeSharedRateLimit(ownerId, 3, 60_000)));
    assert.equal(attempts.filter((attempt) => attempt.allowed).length, 3);
    });
  } finally {
    await db.delete(rateLimits).where(eq(rateLimits.key, createHash("sha256").update(ownerId).digest("hex")));
    await db.delete(jobs).where(sql`${jobs.payload}->>'ownerId' = ${ownerId}`);
    await db.delete(auditEvents).where(eq(auditEvents.ownerId, ownerId));
    await db.delete(users).where(eq(users.id, ownerId));
    await closeDb();
  }
});
