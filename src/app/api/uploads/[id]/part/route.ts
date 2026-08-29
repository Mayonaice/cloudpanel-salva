import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { getOwnedUpload } from "@/lib/files";

import { presignMultipartPart } from "@/lib/storage";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";
import { storageLimits } from "@/lib/storage";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    const owner = await requireSession();
    const upload = await getOwnedUpload(owner.userId, (await context.params).id);
    if (upload.session.expiresAt.getTime() <= Date.now()) throw new HttpError(409, "Upload session expired", "upload_expired");
    const partNumber = Number(new URL(request.url).searchParams.get("partNumber"));
    const partCount = Math.ceil(upload.file.sizeBytes / storageLimits().partBytes);
    if (!upload.session.providerUploadId || !["initiated", "uploading", "completing"].includes(upload.session.status) || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > Math.min(10000, partCount)) {
      throw new HttpError(400, "A valid multipart part number is required", "invalid_part_number");
    }
    const signed = await presignMultipartPart(upload.file.objectKey, upload.session.providerUploadId, partNumber);
    return jsonResponse({ partNumber, ...signed });
  });
}
