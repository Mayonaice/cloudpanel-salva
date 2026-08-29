import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { getOwnedFile, restoreOwnedFile, stagePurge, toPublicFile, trashOwnedFile, updateOwnedFile } from "@/lib/files";
import { readJson } from "@/lib/http";
import { deleteObject } from "@/lib/storage";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";
import { parseOrBad, updateFileSchema } from "@/lib/validation";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    return jsonResponse({ file: toPublicFile(await getOwnedFile((await requireSession()).userId, (await context.params).id)) });
  });
}

export async function PATCH(request: Request, context: Context) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    const session = await requireSession();
    const changes = parseOrBad(updateFileSchema, await readJson(request));
    const file = await updateOwnedFile(session.userId, (await context.params).id, changes);
    return jsonResponse({ file: toPublicFile(file) });
  });
}

export async function DELETE(request: Request, context: Context) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    const session = await requireSession();
    const id = (await context.params).id;
    const action = new URL(request.url).searchParams.get("action") ?? "trash";
    if (!["trash", "restore", "purge"].includes(action)) throw new HttpError(400, "Unknown file action", "invalid_action");
    if (action === "restore") return jsonResponse({ file: toPublicFile(await restoreOwnedFile(session.userId, id)) });
    if (action === "purge") {
      const staged = await stagePurge(session.userId, id);
      if (!staged.alreadyPurged) {
        try {
          await deleteObject(staged.file.objectKey);
        } catch {
          throw new HttpError(502, "Object storage delete failed; purge remains retryable", "storage_delete_failed");
        }
        await finalizePurgeAfterDelete(session.userId, id);
      }
      return jsonResponse({ purged: true });
    }
    return jsonResponse({ file: toPublicFile(await trashOwnedFile(session.userId, id)) });
  });
}

async function finalizePurgeAfterDelete(ownerId: string, fileId: string) {
  const { finalizePurge } = await import("@/lib/files");
  await finalizePurge(ownerId, fileId);
}
