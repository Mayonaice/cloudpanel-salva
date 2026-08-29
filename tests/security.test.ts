import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContentType, normalizeFileName, assertSameOrigin, HttpError } from "../src/lib/security";
import { readJson } from "../src/lib/http";

test("file names reject path and control characters", () => {
  assert.equal(normalizeFileName("  résumé.txt  "), "résumé.txt");
  assert.throws(() => normalizeFileName("folder/file.txt"), (error: unknown) => error instanceof HttpError && error.code === "invalid_name");
  assert.throws(() => normalizeFileName("..\\secret"), (error: unknown) => error instanceof HttpError && error.code === "invalid_name");
  assert.equal(normalizeContentType("IMAGE/PNG"), "image/png");
  assert.equal(normalizeContentType("not a mime"), "application/octet-stream");
  for (const unsafe of ["folder／file.txt", "folder＼file.txt", "bad\tname", "bad\u007fname"]) {
    assert.throws(() => normalizeFileName(unsafe), HttpError);
  }
});

test("mutating requests reject cross-site fetch metadata", () => {
  assert.throws(
    () => assertSameOrigin(new Request("http://localhost:3000/api/files", { headers: { "sec-fetch-site": "cross-site" } })),
    (error: unknown) => error instanceof HttpError && error.code === "origin_forbidden"
  );
  assert.doesNotThrow(() => assertSameOrigin(new Request("http://localhost:3000/api/files")));
});

test("JSON request parsing is bounded before application validation", async () => {
  await assert.rejects(
    () => readJson(new Request("http://localhost:3000/api/files", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(64 * 1024 + 1) },
      body: "{}"
    })),
    (error: unknown) => error instanceof HttpError && error.code === "request_too_large"
  );
  await assert.rejects(
    () => readJson(new Request("http://localhost:3000/api/files", { method: "POST", body: "not-json" })),
    (error: unknown) => error instanceof HttpError && error.code === "invalid_json"
  );
});
