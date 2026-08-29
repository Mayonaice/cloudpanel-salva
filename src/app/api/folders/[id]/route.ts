import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { updateFolder } from "@/lib/folders";
import { readJson } from "@/lib/http";
import { assertSameOrigin, jsonResponse } from "@/lib/security";
import { parseOrBad } from "@/lib/validation";
import { z } from "zod";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const updateSchema = z.object({ name: z.string().min(1).max(255).optional(), parentId: z.string().uuid().nullable().optional() });

export async function PATCH(request: Request, context: Context) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    const owner = await requireSession();
    const id = (await context.params).id;
    const input = parseOrBad(updateSchema, await readJson(request));
    return jsonResponse({ folder: await updateFolder(owner.userId, id, input) });
  });
}
