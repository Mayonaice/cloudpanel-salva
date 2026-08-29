import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { failOrAbortUpload, finalizeUpload, getOwnedUpload, markUploadCompleting, toPublicFile } from "@/lib/files";
import { readJson } from "@/lib/http";
import { completeMultipart, deleteObject, headObject, storageLimits } from "@/lib/storage";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";
import { completeUploadSchema, parseOrBad } from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    const owner = await requireSession();
    const uploadId = (await context.params).id;
    const current = await getOwnedUpload(owner.userId, uploadId);
    if (current.session.status === "completed") return jsonResponse({ file: toPublicFile(current.file), idempotent: true });
    if (current.session.expiresAt.getTime() <= Date.now()) throw new HttpError(409, "Upload session expired", "upload_expired");
    const input = parseOrBad(completeUploadSchema, await readJson(request));
    await markUploadCompleting(owner.userId, uploadId);
    try {
      let head: Awaited<ReturnType<typeof headObject>> | undefined;
      if (current.session.providerUploadId) {
        const partCount = Math.ceil(current.file.sizeBytes / storageLimits().partBytes);
        if (input.parts.length !== partCount) throw new HttpError(400, "All uploaded multipart parts are required", "multipart_parts_incomplete");
        for (const [index, part] of input.parts.entries()) {
          if (part.partNumber !== index + 1) throw new HttpError(400, "Multipart parts must be consecutive and ordered", "multipart_parts_invalid");
        }
        try {
          await completeMultipart(current.file.objectKey, current.session.providerUploadId, input.parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })));
        } catch {
          // A lost CompleteMultipart response can leave the provider object ready.
          // Confirm the object before treating the retry as idempotently complete.
          try {
            head = await headObject(current.file.objectKey);
          } catch {
            throw new HttpError(502, "Object storage completion failed", "storage_complete_failed");
          }
        }
      }
      head ??= await headObject(current.file.objectKey);
      if (head.size !== current.file.sizeBytes) {
        throw new HttpError(422, "Uploaded object size does not match metadata", "object_size_mismatch");
      }
      const file = await finalizeUpload(owner.userId, uploadId, head.checksum ?? null);
      return jsonResponse({ file: toPublicFile(file) });
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.code === "object_size_mismatch") {
          try {
            const failed = await failOrAbortUpload(owner.userId, uploadId, "failed");
            if (failed.shouldCleanup) await deleteObject(current.file.objectKey);
          } catch {
            throw new HttpError(502, "Object storage cleanup failed; completion remains retryable", "storage_cleanup_failed");
          }
        }
        throw error;
      }
      throw new HttpError(502, "Object storage completion failed", "storage_complete_failed");
    }
  });
}
