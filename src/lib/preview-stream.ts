import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { HttpError, secureHeaders } from "./security";
import { canPreview, fileExtension, previewMime } from "./preview-format";

let activeConversions = 0;
export async function streamPreview(request: Request, fileName: string, signedUrl: string): Promise<Response> {
  if (!canPreview({ name: fileName })) throw new HttpError(415, "Preview is not available for this format", "preview_unsupported");
  const converting = fileExtension(fileName) === "mkv";
  const encodedPdf = fileExtension(fileName) === "pdf" && new URL(request.url).searchParams.get("encoding") === "base64";
  if (converting && activeConversions >= 1) throw new HttpError(503, "Another video preview is being prepared. Try again shortly.", "preview_busy");
  const range = request.headers.get("range");
  if (range && !/^bytes=\d*-\d*$/u.test(range)) throw new HttpError(416, "Invalid preview range", "preview_range");
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (converting) activeConversions++;
  let upstream: Response;
  try {
    upstream = await fetch(signedUrl, { headers: { "Accept-Encoding": "identity", ...(!converting && range ? { Range: range } : {}) }, signal: controller.signal, redirect: "error", cache: "no-store" });
    if (!upstream.ok || !upstream.body) throw new HttpError(upstream.status === 404 ? 404 : upstream.status === 416 ? 416 : 502, "Storage could not return this file", "preview_storage_error");
  } catch (error) {
    if (converting) activeConversions--;
    controller.abort(); request.signal.removeEventListener("abort", abort); throw error;
  }
  // PDF bytes are consumed by PDF.js; avoid browser/plugin interception of an application/pdf response.
  const headers = secureHeaders({ "Content-Type": encodedPdf ? "text/plain; charset=us-ascii" : previewMime(fileName), "Content-Disposition": "inline" });
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'");
  if (encodedPdf) {
    // Stream the rendition input in a text-safe representation. This keeps PDF rendering under the app's control across browser/plugin and gateway variations.
    let remainder = Buffer.alloc(0);
    const encoder = new TextEncoder();
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, target) {
        const buffer = Buffer.concat([remainder, chunk]);
        const complete = buffer.length - buffer.length % 3;
        if (complete) target.enqueue(encoder.encode(buffer.subarray(0, complete).toString("base64")));
        remainder = Buffer.from(buffer.subarray(complete));
      },
      flush(target) { if (remainder.length) target.enqueue(encoder.encode(remainder.toString("base64"))); request.signal.removeEventListener("abort", abort); }
    });
    return new Response(upstream.body!.pipeThrough(transform), { headers });
  }
  if (!converting) {
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      // Fetch transparently decompresses upstream bodies. A compressed length would truncate the decoded response.
      if (name === "content-length" && upstream.headers.get("content-encoding") && upstream.headers.get("content-encoding") !== "identity") continue;
      const value = upstream.headers.get(name); if (value) headers.set(name, value);
    }
    const reader = upstream.body!.getReader();
    const cleanup = () => request.signal.removeEventListener("abort", abort);
    const body = new ReadableStream<Uint8Array>({
      async pull(target) { try { const part = await reader.read(); if (part.done) { cleanup(); target.close(); } else target.enqueue(part.value); } catch (error) { cleanup(); target.error(error); } },
      async cancel() { cleanup(); controller.abort(); await reader.cancel().catch(() => {}); }
    });
    return new Response(body, { status: upstream.status, headers });
  }
  // Input is a pipe. Explicit Matroska demuxing and protocol restrictions prevent embedded URLs from opening files/network resources.
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "pipe", "-threads", "1", "-f", "matroska", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-vf", "scale=w='min(1280,iw)':h=-2", "-filter_threads", "1", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-crf", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000", "-f", "mp4", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; activeConversions--; clearTimeout(timeout); controller.abort(); request.signal.removeEventListener("abort", stop); request.signal.removeEventListener("abort", abort); child.kill("SIGKILL"); };
  const stop = () => cleanup();
  const timeout = setTimeout(cleanup, 2 * 60 * 60 * 1000);
  request.signal.addEventListener("abort", stop, { once: true });
  child.stderr.resume();
  child.on("close", cleanup);
  child.on("error", cleanup);
  try { await once(child, "spawn"); } catch { cleanup(); throw new HttpError(503, "Video preview service is unavailable", "preview_converter_unavailable"); }
  void pipeline(Readable.fromWeb(upstream.body! as import("node:stream/web").ReadableStream), child.stdin).catch(() => cleanup());
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const reader = output.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(target) { try { const part = await reader.read(); if (part.done) { cleanup(); target.close(); } else target.enqueue(part.value); } catch (error) { cleanup(); target.error(error); } },
    async cancel() { cleanup(); await reader.cancel().catch(() => {}); }
  });
  return new Response(body, { headers });
}
