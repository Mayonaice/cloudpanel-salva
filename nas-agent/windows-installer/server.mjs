import http from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHmac, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { pathToFileURL } from "node:url";

const fail = (status, message) => Object.assign(new Error(message), { status });
const equal = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const uuid = /^[a-f0-9-]{36}$/;

export async function createNasAgent({ root, token, origin, publicUrl }) {
  if (!root || !token || token.length < 32 || !origin || !publicUrl) throw new Error("Configure root, a 32+ character token, origin and publicUrl");
  const rootPath = await fs.realpath(root);
  const privatePath = path.join(rootPath, ".cloud-agent");
  await fs.mkdir(privatePath, { recursive: true });
  if ((await fs.lstat(privatePath)).isSymbolicLink()) throw new Error("Agent metadata directory cannot be a symlink");

  async function safePath(key, allowMissing = false) {
    if (typeof key !== "string" || !key || Buffer.byteLength(key) > 1024 || /[\\\x00-\x1f\x7f:]/.test(key)) throw fail(400, "Invalid path");
    const segments = key.replace(/\/$/, "").split("/");
    if (segments.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)) || segments[0].toLowerCase() === ".cloud-agent") throw fail(400, "Invalid path");
    let current = rootPath;
    for (const part of segments) {
      current = path.join(current, part);
      const relative = path.relative(rootPath, current);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw fail(403, "Path outside root");
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw fail(403, "Symlinks are not accessible"); }
      catch (error) { if (error.code !== "ENOENT" || !allowMissing) throw error; }
    }
    return current;
  }
  async function jsonBody(req, max = 65536) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > max) throw fail(413, "Body too large"); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks)); } catch { throw fail(400, "Invalid JSON"); }
  }
  async function head(key) {
    const stat = await fs.stat(await safePath(key));
    if (!stat.isFile()) throw fail(404, "File not found");
    return { size: stat.size, etag: `"${stat.size}-${stat.mtimeMs}"` };
  }
  function signed(method, input, ttl = 300) {
    const payload = Buffer.from(JSON.stringify({ ...input, method, expires: Date.now() + Math.min(300, Math.max(1, ttl)) * 1000 })).toString("base64url");
    const signature = createHmac("sha256", token).update(payload).digest("base64url");
    return { url: `${publicUrl}/v1/transfer?token=${payload}.${signature}`, expiresIn: Math.min(300, ttl) };
  }
  async function uploadMetadata(id) {
    if (!uuid.test(id ?? "")) throw fail(400, "Invalid upload ID");
    const directory = path.join(privatePath, id);
    const metadata = JSON.parse(await fs.readFile(path.join(directory, "metadata.json"), "utf8"));
    if (metadata.expires < Date.now()) throw fail(410, "Upload expired");
    return { directory, metadata };
  }
  async function removeUpload(id) {
    if (!uuid.test(id ?? "")) throw fail(400, "Invalid upload ID");
    const directory = path.resolve(privatePath, id);
    if (path.dirname(directory) !== privatePath) throw fail(403, "Invalid cleanup path");
    await fs.rm(directory, { recursive: true, force: true });
  }
  async function list() {
    const objects = [];
    async function walk(directory, prefix = "", depth = 0) {
      if (depth > 32) throw fail(409, "Folder nesting limit exceeded");
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.toLowerCase() === ".cloud-agent") continue;
        const objectKey = prefix + entry.name;
        const target = await safePath(objectKey);
        if (entry.isDirectory()) { objects.push({ objectKey: objectKey + "/", size: 0 }); await walk(target, objectKey + "/", depth + 1); }
        else if (entry.isFile()) objects.push({ objectKey, size: (await fs.stat(target)).size });
        if (objects.length > 20000) throw fail(409, "Directory requires a larger index service");
      }
    }
    await walk(rootPath);
    return objects.sort((a, b) => a.objectKey.localeCompare(b.objectKey));
  }
  async function control(operation, input) {
    if (operation === "health") { const stat = await fs.statfs(rootPath); return { ok: true, protocol: "cloud-nas-v1", capacityBytes: stat.blocks * stat.bsize, availableBytes: stat.bavail * stat.bsize }; }
    if (operation === "head") return head(input.key);
    if (operation === "mkdir") { const target = await safePath(input.key, true); await fs.mkdir(target, { recursive: true }); return { ok: true }; }
    if (operation === "rmdir") { await fs.rmdir(await safePath(input.key)); return { ok: true }; }
    if (operation === "delete") { try { await fs.unlink(await safePath(input.key)); } catch (error) { if (error.code !== "ENOENT") throw error; } return { ok: true }; }
    if (operation === "list") {
      const objects = await list(); const start = Number(input.continuationToken ?? 0);
      if (!Number.isSafeInteger(start) || start < 0) throw fail(400, "Invalid page");
      return { objects: objects.slice(start, start + 1000), ...(start + 1000 < objects.length ? { continuationToken: String(start + 1000) } : {}) };
    }
    if (operation === "signPut") { await safePath(input.objectKey, true); return signed("PUT", { key: input.objectKey, contentType: input.contentType, maxBytes: 64 * 1024 ** 2 }); }
    if (operation === "signGet") { await head(input.objectKey); return signed("GET", { key: input.objectKey, fileName: input.fileName }, input.expiresIn); }
    if (operation === "createMultipart") {
      await safePath(input.objectKey, true); const uploadId = randomUUID();
      const directory = path.join(privatePath, uploadId); await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, "metadata.json"), JSON.stringify({ key: input.objectKey, contentType: input.contentType, expires: Date.now() + 86400000 }));
      return { uploadId };
    }
    if (operation === "signPart") {
      const { metadata } = await uploadMetadata(input.uploadId);
      if (metadata.key !== input.objectKey || !Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > 10000) throw fail(400, "Invalid part");
      return signed("PUT", { uploadId: input.uploadId, partNumber: input.partNumber, maxBytes: 32 * 1024 ** 2 });
    }
    if (operation === "abortMultipart") { await removeUpload(input.uploadId); return { ok: true }; }
    if (operation === "completeMultipart") {
      const { directory, metadata } = await uploadMetadata(input.uploadId);
      if (metadata.key !== input.objectKey || !Array.isArray(input.parts) || !input.parts.length || input.parts.length > 10000) throw fail(400, "Invalid completion");
      const destination = await safePath(metadata.key, true);
      const temporary = path.join(privatePath, randomUUID() + ".tmp");
      let size = 0;
      try {
        const output = await fs.open(temporary, "wx");
        try {
          for (const [index, part] of input.parts.entries()) {
            if (part.partNumber !== index + 1) throw fail(400, "Parts must be consecutive");
            const data = await fs.readFile(path.join(directory, `${part.partNumber}.part`));
            const etag = '"' + createHash("sha256").update(data).digest("hex") + '"';
            if (part.etag !== etag) throw fail(400, "Part checksum mismatch");
            size += data.length; if (size > 5 * 1024 ** 3) throw fail(413, "File too large");
            await output.write(data);
          }
        } finally { await output.close(); }
        await safePath(metadata.key, true);
        await fs.link(temporary, destination);
      } finally { await fs.rm(temporary, { force: true }); }
      await removeUpload(input.uploadId);
      return { size };
    }
    throw fail(400, "Unknown operation");
  }

  const server = http.createServer(async (req, res) => {
    const originAllowed = req.headers.origin === origin;
    if (originAllowed) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); res.setHeader("Access-Control-Expose-Headers", "ETag"); }
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (req.method === "OPTIONS") {
        if (!originAllowed) throw fail(403, "Origin not allowed");
        res.writeHead(204, { "Access-Control-Allow-Methods": "GET, PUT, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, If-None-Match", "Access-Control-Max-Age": "600" }); res.end(); return;
      }
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/v1/control" && req.method === "POST") {
        if (!equal(req.headers.authorization, `Bearer ${token}`)) throw fail(401, "Unauthorized");
        const { operation, input = {} } = await jsonBody(req);
        const result = await control(operation, input);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); return;
      }
      if (url.pathname !== "/v1/transfer") throw fail(404, "Not found");
      const [payload, signature] = (url.searchParams.get("token") ?? "").split(".");
      if (!payload || !equal(signature, createHmac("sha256", token).update(payload).digest("base64url"))) throw fail(403, "Invalid transfer token");
      const grant = JSON.parse(Buffer.from(payload, "base64url"));
      if (grant.method !== req.method || !Number.isSafeInteger(grant.expires) || grant.expires < Date.now()) throw fail(403, "Transfer expired");
      if (req.method === "GET") {
        const target = await safePath(grant.key); const stat = await fs.stat(target);
        let start = 0; let end = stat.size - 1;
        if (req.headers.range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
          if (!match) throw fail(416, "Unsupported range");
          start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
          if (start > end || start >= stat.size || end >= stat.size) throw fail(416, "Invalid range");
          res.statusCode = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        }
        res.setHeader("Content-Type", "application/octet-stream"); res.setHeader("Content-Length", stat.size ? end - start + 1 : 0); res.setHeader("Accept-Ranges", "bytes");
        const name = String(grant.fileName ?? "download").replace(/[\r\n\\/]/g, "_");
        res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`);
        if (!stat.size) res.end(); else await pipeline(createReadStream(target, { start, end }), res);
        return;
      }
      if (req.method !== "PUT" || (req.headers.origin && !originAllowed)) throw fail(403, "Transfer not allowed");
      let destination;
      if (grant.uploadId) { const { directory } = await uploadMetadata(grant.uploadId); destination = path.join(directory, `${grant.partNumber}.part`); }
      else destination = await safePath(grant.key, true);
      const temporary = path.join(privatePath, randomUUID() + ".tmp");
      let bytes = 0; const hash = createHash("sha256");
      const meter = new Transform({ transform(chunk, _encoding, next) { bytes += chunk.length; if (bytes > grant.maxBytes) { next(fail(413, "Transfer too large")); return; } hash.update(chunk); next(null, chunk); } });
      try {
        await pipeline(req, meter, createWriteStream(temporary, { flags: "wx" }));
        if (grant.uploadId) await fs.rename(temporary, destination);
        else { await safePath(grant.key, true); await fs.link(temporary, destination); }
      } finally { await fs.rm(temporary, { force: true }); }
      res.writeHead(200, { ETag: '"' + hash.digest("hex") + '"' }); res.end();
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      res.writeHead(error.status ?? (error.code === "ENOENT" ? 404 : error.code === "EEXIST" || error.code === "ENOTEMPTY" ? 409 : 500), { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: error.status ? error.message : "NAS operation failed" }));
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = await createNasAgent({ root: process.env.NAS_ROOT, token: process.env.NAS_TOKEN, origin: process.env.APP_ORIGIN, publicUrl: process.env.NAS_PUBLIC_URL });
  const port = Number(process.env.PORT ?? 8787);
  server.listen(port, "127.0.0.1", () => console.log(`NAS agent listening on loopback port ${port}`));
}
