import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireOwner, requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { handleRoute, readJson } from "@/lib/http";
import { assertSameOrigin, jsonResponse } from "@/lib/security";
import { parseOrBad } from "@/lib/validation";
export const GET = () => handleRoute(async () => jsonResponse({ profile: await requireSession() }));
export const PATCH = (request: Request) => handleRoute(async () => {
  assertSameOrigin(request);
  const owner = await requireOwner();
  const { displayName } = parseOrBad(z.object({ displayName: z.string().trim().min(1).max(160) }), await readJson(request));
  await getDb().update(users).set({ displayName, updatedAt: new Date() }).where(eq(users.id, owner.userId));
  return jsonResponse({ profile: { ...owner, displayName } });
});
