import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { getOwnedFile } from "@/lib/files";
import { presignGet } from "@/lib/storage";
import { HttpError } from "@/lib/security";
import { streamPreview } from "@/lib/preview-stream";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleStorageRoute(request, async () => {
    const owner = await requireSession();
    const file = await getOwnedFile(owner.userId, (await context.params).id);
    if (file.status !== "ready" || file.trashedAt) throw new HttpError(404, "File is not available", "file_unavailable");
    const signed = await presignGet(file.objectKey, file.name);
    return streamPreview(request, file.name, signed.url);
  });
}
