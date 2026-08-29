import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { requireOwner, requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { guestKeys } from "@/lib/db/schema";
import { handleRoute, readJson } from "@/lib/http";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";
import { parseOrBad } from "@/lib/validation";
import { generateGuestKey, hashGuestKey } from "@/lib/guest-keys";

export const GET = (request: Request) => handleRoute(async () => { assertSameOrigin(request); const session = await requireSession(); if (session.role !== "owner" && session.role !== "admin") throw new HttpError(403, "Guest keys are only available to owners and administrators", "forbidden"); const keys = await getDb().select({ id: guestKeys.id, name: guestKeys.name, role: guestKeys.role, lastUsedAt: guestKeys.lastUsedAt, createdAt: guestKeys.createdAt }).from(guestKeys).where(and(eq(guestKeys.ownerId, session.userId), isNull(guestKeys.revokedAt))).orderBy(desc(guestKeys.createdAt)); return jsonResponse({ keys }); });
export const POST = (request: Request) => handleRoute(async () => { assertSameOrigin(request); const owner = await requireOwner(); const body = parseOrBad(z.object({ name: z.string().trim().min(1).max(80), role: z.enum(["admin","full","readonly"]) }), await readJson(request)); const active = await getDb().select({ id: guestKeys.id }).from(guestKeys).where(and(eq(guestKeys.ownerId, owner.userId), isNull(guestKeys.revokedAt))); if (active.length >= 20) throw new HttpError(409, "Maximum of 20 active guest keys reached", "key_limit"); const token = generateGuestKey(); const [created] = await getDb().insert(guestKeys).values({ ownerId: owner.userId, name: body.name, role: body.role, tokenHash: hashGuestKey(token) }).returning({ id: guestKeys.id, name: guestKeys.name, role: guestKeys.role, createdAt: guestKeys.createdAt }); return jsonResponse({ key: token, record: created }, { status: 201 }); });
