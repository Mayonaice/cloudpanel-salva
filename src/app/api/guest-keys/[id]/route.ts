import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { guestKeys } from "@/lib/db/schema";
import { handleRoute } from "@/lib/http";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) { return handleRoute(async () => { assertSameOrigin(request); const owner = await requireOwner(); const id = z.string().uuid().safeParse((await context.params).id); if (!id.success) throw new HttpError(400, "Invalid key ID", "invalid_id"); const [row] = await getDb().update(guestKeys).set({ revokedAt: new Date() }).where(and(eq(guestKeys.id, id.data), eq(guestKeys.ownerId, owner.userId))).returning({ id: guestKeys.id }); if (!row) throw new HttpError(404, "Key not found", "not_found"); return jsonResponse({ revoked: true }); }); }
