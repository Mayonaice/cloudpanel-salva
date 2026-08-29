import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { failOrAbortUpload } from "@/lib/files";

import { abortMultipart, deleteObject } from "@/lib/storage";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    const owner = await requireSession();
    const uploadId = (await context.params).id;
    // Claim metadata first: a concurrent completion must not become a ready
    // file while this request is deleting its storage object.
    const current = await failOrAbortUpload(owner.userId, uploadId, "aborted");
    if (!current.shouldCleanup) return jsonResponse({ aborted: false, idempotent: true });
    try {
      if (current.session.providerUploadId) await abortMultipart(current.file.objectKey, current.session.providerUploadId);
      await deleteObject(current.file.objectKey);
    } catch {
      throw new HttpError(502, "Object storage cleanup failed; abort remains retryable", "storage_cleanup_failed");
    }
    return jsonResponse({ aborted: true });
  });
}
