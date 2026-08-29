import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { createFolder } from "@/lib/folders";
import { readJson } from "@/lib/http";
import { assertSameOrigin, jsonResponse } from "@/lib/security";
import { parseOrBad } from "@/lib/validation";
import { z } from "zod";

export const runtime = "nodejs";
const createFolderSchema = z.object({ name: z.string().min(1).max(255), parentId: z.string().uuid().nullable().optional() });

export async function POST(request: Request) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    const owner = await requireSession();
    const input = parseOrBad(createFolderSchema, await readJson(request));
    return jsonResponse({ folder: await createFolder(owner.userId, input.name, input.parentId) }, { status: 201 });
  });
}
