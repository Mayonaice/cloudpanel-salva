import assert from "node:assert/strict";
import test from "node:test";
import { createMockStorageProvider } from "../src/lib/mock-storage-provider";
import { createOpaqueObjectKey, getStorageProvider } from "../src/lib/storage";
import { HttpError } from "../src/lib/security";
import { isStorageReady } from "../src/lib/env";

test("mock provider covers direct upload, range reads, multipart resume, and delete", async () => {
  const provider = createMockStorageProvider();
  const key = createOpaqueObjectKey();
  const body = new TextEncoder().encode("private object body");

  assert.equal(provider.capabilities.presignedPut, true);
  assert.equal((await provider.createPresignedPut({ objectKey: key, contentType: "text/plain", sizeBytes: body.byteLength })).url.startsWith("mock://put/"), true);
  assert.equal((await provider.createPresignedGet({ objectKey: key, fileName: "body.txt", expiresIn: 999 })).expiresIn, 300);
  const putHead = await provider.putObject({ objectKey: key, contentType: "text/plain", body });
  assert.equal(putHead.size, body.byteLength);
  assert.equal(putHead.checksum?.length, 64);
  assert.deepEqual([...await provider.getObject({ objectKey: key, range: { start: 8, end: 13 } }) .then((result) => result.body)], [...new TextEncoder().encode("object")]);

  const multipartKey = createOpaqueObjectKey();
  const first = new TextEncoder().encode("first-");
  const second = new TextEncoder().encode("second");
  const { uploadId } = await provider.createMultipart({ objectKey: multipartKey, contentType: "text/plain" });
  const firstPart = await provider.uploadPart({ objectKey: multipartKey, uploadId, partNumber: 1, body: first });
  assert.deepEqual(await provider.listParts({ objectKey: multipartKey, uploadId }), [firstPart]);
  const secondPart = await provider.uploadPart({ objectKey: multipartKey, uploadId, partNumber: 2, body: second });
  const completeHead = await provider.completeMultipart({ objectKey: multipartKey, uploadId, parts: [secondPart, firstPart] });
  assert.equal(completeHead.size, first.byteLength + second.byteLength);
  assert.deepEqual([...await provider.getObject({ objectKey: multipartKey }).then((result) => result.body)], [...new TextEncoder().encode("first-second")]);

  const listed = await provider.listObjects();
  assert.deepEqual(listed.objects.map((object) => object.objectKey), [key, multipartKey].sort());
  await provider.deleteObject(key);
  await assert.rejects(() => provider.headObject(key), (error: unknown) => (error as { code?: string }).code === "not_found");
});

test("mock provider rejects path-like keys and invalid ranges", async () => {
  const provider = createMockStorageProvider();
  await assert.rejects(() => provider.createPresignedGet({ objectKey: "folder/file", fileName: "file" }));
  const key = createOpaqueObjectKey();
  await provider.putObject({ objectKey: key, contentType: "application/octet-stream", body: new Uint8Array([1, 2, 3]) });
  await assert.rejects(() => provider.getObject({ objectKey: key, range: { start: 0, end: 3 } }));
});

test("live provider access fails closed until explicit compatibility readiness", () => {
  assert.equal(isStorageReady({ configured: true, liveEnabled: false, compatibilityVerified: true }), false);
  assert.equal(isStorageReady({ configured: true, liveEnabled: true, compatibilityVerified: false }), false);
  assert.equal(isStorageReady({ configured: true, liveEnabled: true, compatibilityVerified: true }), true);
  try {
    getStorageProvider();
    // A developer may intentionally run the test suite with all live gates
    // set, but this test must never cause a provider request.
  } catch (error) {
    assert.equal(error instanceof HttpError, true);
    assert.equal((error as HttpError).code, "storage_required");
  }
});
