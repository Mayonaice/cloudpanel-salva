import { and, eq, isNull } from "drizzle-orm";
import { requireWriteAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { shares } from "@/lib/db/schema";
import { handleRoute } from "@/lib/http";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";
import { parseOrBad } from "@/lib/validation";
import { z } from "zod";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
const idSchema = z.object({ id: z.string().uuid() });

export async function DELETE(request: Request, context: Context) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const owner = await requireWriteAccess();
    const { id } = parseOrBad(idSchema, await context.params);
    const [share] = await getDb().update(shares)
      .set({ revokedAt: new Date() })
      .where(and(eq(shares.id, id), eq(shares.ownerId, owner.userId), isNull(shares.revokedAt)))
      .returning({ id: shares.id });
    if (!share) throw new HttpError(404, "Share link not found", "share_not_found");
    return jsonResponse({ revoked: true, id: share.id });
  });
}
