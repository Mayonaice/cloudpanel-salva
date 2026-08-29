import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { getOwnedFile } from "@/lib/files";

import { presignGet } from "@/lib/storage";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    const owner = await requireSession();
    const file = await getOwnedFile(owner.userId, (await context.params).id);
    if (file.status !== "ready" || file.trashedAt) throw new HttpError(404, "File is not available", "file_unavailable");
    const signed = await presignGet(file.objectKey, file.name);
    return jsonResponse({ url: signed.url, expiresIn: signed.expiresIn });
  });
}
