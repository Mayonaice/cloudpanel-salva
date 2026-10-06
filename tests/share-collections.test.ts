import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { descendantFolderPaths, canManageShares, canRevealSharePassword } from "../src/lib/share-policy";
import { canPreview, previewMime } from "../src/lib/preview-format";
import { encryptCredentials, decryptCredentials } from "../src/lib/credential-vault";
import { streamPreview } from "../src/lib/preview-stream";

test("folder shares include nested descendants without siblings or cycles", () => {
  const paths = descendantFolderPaths([
    { id: "root", parentId: "nested", name: "Shared" },
    { id: "child", parentId: "root", name: "Photos" },
    { id: "nested", parentId: "child", name: "Trips" },
    { id: "sibling", parentId: null, name: "Private" },
    { id: "private-child", parentId: "sibling", name: "Secrets" }
  ], "root");
  assert.deepEqual([...paths], [["root", ""], ["child", "Photos/"], ["nested", "Photos/Trips/"]]);
});

test("share management and password visibility follow each role", () => {
  for (const role of ["owner", "admin", "full", "readonly"] as const) {
    assert.equal(canManageShares(role), role !== "readonly");
    assert.equal(canRevealSharePassword(role), role === "owner" || role === "admin");
  }
});

test("all requested formats can be previewed independent of MIME or filename case", () => {
  for (const extension of ["mp4", "png", "jpg", "jpeg", "mkv", "pdf", "docx", "xlsx", "csv"]) assert.equal(canPreview({ name: `My file.${extension.toUpperCase()}` }), true);
  assert.equal(canPreview({ name: "image.png.exe" }), false);
  assert.equal(previewMime("video.mkv"), "video/mp4");
  assert.equal(previewMime("document.PDF"), "application/pdf");
});

test("recoverable share secrets are encrypted and bound to their purpose and share", () => {
  const original = process.env.STORAGE_ENCRYPTION_KEY;
  process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  try {
    const encrypted = encryptCredentials({ password: "private-password" }, "share-password:first");
    assert.equal(encrypted.includes("private-password"), false);
    assert.deepEqual(decryptCredentials(encrypted, "share-password:first"), { password: "private-password" });
    assert.throws(() => decryptCredentials(encrypted, "share-password:second"));
    assert.throws(() => decryptCredentials(encrypted, "share-token:first"));
  } finally { if (original === undefined) delete process.env.STORAGE_ENCRYPTION_KEY; else process.env.STORAGE_ENCRYPTION_KEY = original; }
});

test("preview proxy preserves range delivery and uses inline MIME with private caching", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.deepEqual(init?.headers, { "Accept-Encoding": "identity", Range: "bytes=0-3" });
    assert.equal(init?.redirect, "error");
    return new Response(new Uint8Array([0, 1, 2, 3]), { status: 206, headers: { "Content-Range": "bytes 0-3/12", "Content-Length": "4", "Accept-Ranges": "bytes" } });
  };
  try {
    const response = await streamPreview(new Request("https://cloud.example/preview", { headers: { Range: "bytes=0-3" } }), "clip.mp4", "https://storage.example/signed");
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(response.headers.get("content-range"), "bytes 0-3/12");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-disposition"), "inline");
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal((await response.arrayBuffer()).byteLength, 4);
    await assert.rejects(() => streamPreview(new Request("https://cloud.example/preview", { headers: { Range: "bytes=1-2,4-5" } }), "clip.mp4", "https://storage.example/signed"));
    await assert.rejects(() => streamPreview(new Request("https://cloud.example/preview"), "page.html", "https://storage.example/signed"));
  } finally { globalThis.fetch = original; }
});

test("PDF transport preserves bytes when encoding across uneven stream chunks", async () => {
  const original = globalThis.fetch;
  const bytes = new TextEncoder().encode("%PDF-1.4\nPreview content\n%%EOF");
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 1)); controller.enqueue(bytes.slice(1, 5)); controller.enqueue(bytes.slice(5)); controller.close(); } }));
  try {
    const response = await streamPreview(new Request("https://cloud.example/preview?encoding=base64"), "sample.pdf", "https://storage.example/signed");
    assert.equal(response.headers.get("content-type"), "text/plain; charset=us-ascii");
    assert.deepEqual(new Uint8Array(Buffer.from(await response.text(), "base64")), bytes);
  } finally { globalThis.fetch = original; }
});

test("decompressed preview bodies do not forward a stale compressed length", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("Name,Value\nCSV,Ready", { headers: { "content-encoding": "gzip", "content-length": "90" } });
  try {
    const response = await streamPreview(new Request("https://cloud.example/preview"), "sample.csv", "https://storage.example/signed");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(await response.text(), "Name,Value\nCSV,Ready");
  } finally { globalThis.fetch = original; }
});
