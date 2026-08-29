import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { getOwnedUpload } from "@/lib/files";

import { presignMultipartPart, storageLimits } from "@/lib/storage";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    const session = await requireSession();
    const upload = await getOwnedUpload(session.userId, (await context.params).id);
    const url = new URL(request.url);
    const partNumber = Number(url.searchParams.get("partNumber") ?? "0");
    let partUrl: { url: string; expiresIn: number } | null = null;
    if (Number.isInteger(partNumber) && partNumber > 0) {
      if (!upload.session.providerUploadId || !["initiated", "uploading", "completing"].includes(upload.session.status)) {
        throw new HttpError(409, "Upload is not open for multipart transfers", "upload_state_conflict");
      }
      const partCount = Math.ceil(upload.file.sizeBytes / storageLimits().partBytes);
      if (partNumber > partCount) throw new HttpError(400, "Multipart part number is outside the upload", "invalid_part_number");
      partUrl = await presignMultipartPart(upload.file.objectKey, upload.session.providerUploadId, partNumber);
    }
    return jsonResponse({
      upload: {
        id: upload.session.id,
        fileId: upload.file.id,
        status: upload.session.status,
        sizeBytes: upload.file.sizeBytes,
        partBytes: storageLimits().partBytes,
        partUrl
      }
    });
  });
}
