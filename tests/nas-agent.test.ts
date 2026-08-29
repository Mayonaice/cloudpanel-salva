import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createNasAgent } from "../nas-agent/server.mjs";

test("NAS agent confines files and implements real folder/upload/download/delete", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-nas-test-"));
  const token = randomBytes(32).toString("hex");
  const origin = "https://cloud.example.test";
  const server = await createNasAgent({ root, token, origin, publicUrl: "https://nas.example.test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function control(operation: string, input: unknown = {}, expected = 200) {
    const response = await fetch(`${base}/v1/control`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation, input }) });
    assert.equal(response.status, expected); return response.json();
  }
  const localUrl = (url: string) => base + new URL(url).pathname + new URL(url).search;
  try {
    const denied = await fetch(`${base}/v1/control`, { method: "POST", body: "{}" }); assert.equal(denied.status, 401);
    await control("head", { key: "../outside.txt" }, 400);
    await control("head", { key: ".cloud-agent/token" }, 400);
    await control("mkdir", { key: "Videos/" });
    assert.equal((await fs.stat(path.join(root, "Videos"))).isDirectory(), true);
    const signed = await control("signPut", { objectKey: "Videos/test.mp4", contentType: "video/mp4" });
    const put = await fetch(localUrl(signed.url), { method: "PUT", headers: { Origin: origin }, body: "video fixture" }); assert.equal(put.status, 200);
    const replay = await fetch(localUrl(signed.url), { method: "PUT", body: "overwrite" }); assert.equal(replay.status, 409);
    assert.equal((await control("head", { key: "Videos/test.mp4" })).size, 13);
    const get = await control("signGet", { objectKey: "Videos/test.mp4", fileName: "test.mp4" });
    assert.equal(await (await fetch(localUrl(get.url))).text(), "video fixture");
    const range = await fetch(localUrl(get.url), { headers: { Range: "bytes=0-4" } }); assert.equal(range.status, 206); assert.equal(await range.text(), "video");
    const listing = await control("list"); assert.deepEqual(listing.objects.map((item: { objectKey: string }) => item.objectKey), ["Videos/", "Videos/test.mp4"]);
    const upload = await control("createMultipart", { objectKey: "Videos/parts.bin" });
    const parts = [];
    for (const [index, body] of ["one", "two"].entries()) {
      const part = await control("signPart", { objectKey: "Videos/parts.bin", uploadId: upload.uploadId, partNumber: index + 1 });
      const response = await fetch(localUrl(part.url), { method: "PUT", body });
      assert.equal(response.status, 200); parts.push({ partNumber: index + 1, etag: response.headers.get("etag") });
    }
    assert.equal((await control("completeMultipart", { objectKey: "Videos/parts.bin", uploadId: upload.uploadId, parts })).size, 6);
    assert.equal(await fs.readFile(path.join(root, "Videos/parts.bin"), "utf8"), "onetwo");
    await control("delete", { key: "Videos/test.mp4" }); await control("delete", { key: "Videos/parts.bin" });
    await control("rmdir", { key: "Videos/" });
    assert.deepEqual((await control("list")).objects, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const target = path.resolve(root);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("cloud-nas-test-")) throw new Error("Unsafe test cleanup path");
    await fs.rm(target, { recursive: true });
  }
});
