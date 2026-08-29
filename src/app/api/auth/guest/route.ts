import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { setSessionCookie } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { guestKeys, users } from "@/lib/db/schema";
import { handleRoute, readJson } from "@/lib/http";
import { consumeSharedRateLimit, requestClientKey } from "@/lib/rate-limit";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";
import { parseOrBad } from "@/lib/validation";
import { hashGuestKey } from "@/lib/guest-keys";

export async function POST(request: Request) { return handleRoute(async () => {
  assertSameOrigin(request);
  const rate = await consumeSharedRateLimit(`guest-login:${requestClientKey(request)}`, 8, 15 * 60_000);
  if (!rate.allowed) throw new HttpError(429, "Too many attempts. Try again later.", "rate_limited");
  const { key } = parseOrBad(z.object({ key: z.string().trim().min(70).max(200) }), await readJson(request));
  const tokenHash = hashGuestKey(key);
  const [record] = await getDb().select({ id: guestKeys.id, ownerId: guestKeys.ownerId, name: guestKeys.name, role: guestKeys.role, email: users.email, displayName: users.displayName })
    .from(guestKeys).innerJoin(users, eq(users.id, guestKeys.ownerId)).where(and(eq(guestKeys.tokenHash, tokenHash), isNull(guestKeys.revokedAt))).limit(1);
  if (!record || !["admin","full","readonly"].includes(record.role)) throw new HttpError(401, "Invalid or revoked login key", "invalid_key");
  await getDb().update(guestKeys).set({ lastUsedAt: new Date() }).where(eq(guestKeys.id, record.id));
  await setSessionCookie({ userId: record.ownerId, email: record.email, displayName: record.displayName, authType: "guest", role: record.role as "admin"|"full"|"readonly", guestKeyId: record.id });
  return jsonResponse({ ok: true });
}); }
