import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireSession } from "./auth";
import { getDb } from "./db";
import { files, folders, uploadSessions } from "./db/schema";
import { assertSameOrigin, errorResponse, HttpError } from "./security";
import { withConnection } from "./storage-context";

export async function handleStorageRoute(request: Request, operation: () => Promise<Response>): Promise<Response> {
  try {
    assertSameOrigin(request);
    const owner = await requireSession();
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (owner.role === "readonly" && (request.method !== "GET" || segments[1] === "uploads")) throw new HttpError(403, "This key has read-only access", "read_only");
    let id = request.headers.get("x-storage-id") ?? url.searchParams.get("storageId");
    if (segments[2] && ["files", "folders", "uploads"].includes(segments[1])) {
      const resourceId = z.string().uuid().safeParse(segments[2]);
      if (!resourceId.success) throw new HttpError(400, "Invalid resource ID", "invalid_id");
      const table = segments[1] === "files" ? files : segments[1] === "folders" ? folders : uploadSessions;
      const [resource] = await getDb().select({ storageId: table.storageId }).from(table).where(and(eq(table.id, resourceId.data), eq(table.ownerId, owner.userId))).limit(1);
      if (!resource || (id && resource.storageId !== id)) throw new HttpError(404, "Resource not found in this storage", "resource_not_found");
      id = resource.storageId;
    }
    if (!id || !z.string().uuid().safeParse(id).success) throw new HttpError(400, "Select a storage connection", "storage_required");
    return await withConnection(id, owner.userId, operation);
  } catch (error) { return errorResponse(error); }
}
