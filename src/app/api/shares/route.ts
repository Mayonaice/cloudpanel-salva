import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { shares } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { getOwnedFile } from "@/lib/files";
import { createShareToken, hashSharePassword } from "@/lib/share";
import { readJson } from "@/lib/http";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";
import { parseOrBad } from "@/lib/validation";
import { z } from "zod";
import { and, desc, eq, isNotNull } from "drizzle-orm";

export const runtime = "nodejs";
export const GET = (request: Request) => handleStorageRoute(request, async () => {
  assertSameOrigin(request);
  const owner = await requireSession();
  const fileId = parseOrBad(z.string().uuid(), new URL(request.url).searchParams.get("fileId"));
  await getOwnedFile(owner.userId, fileId);
  const links = await getDb().select({ id: shares.id, expiresAt: shares.expiresAt, revokedAt: shares.revokedAt, createdAt: shares.createdAt, passwordProtected: isNotNull(shares.passwordHash) }).from(shares).where(and(eq(shares.ownerId, owner.userId), eq(shares.fileId, fileId))).orderBy(desc(shares.createdAt)).limit(100);
  return jsonResponse({ shares: links });
});
const createShareSchema = z.object({
  fileId: z.string().uuid(),
  expiresInDays: z.number().int().positive().optional(),
  password: z.string().min(8).max(128).optional()
});

export async function POST(request: Request) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    const owner = await requireSession();
    const input = parseOrBad(createShareSchema, await readJson(request));
    const file = await getOwnedFile(owner.userId, input.fileId);
    if (file.status !== "ready" || file.trashedAt) throw new HttpError(409, "Only active files can be shared", "file_not_shareable");
    const env = getEnv();
    const days = Math.min(input.expiresInDays ?? env.SHARE_DEFAULT_DAYS, env.SHARE_MAX_DAYS);
    const token = createShareToken();
    const passwordHash = input.password ? await hashSharePassword(input.password) : null;
    const [created] = await getDb().insert(shares).values({
      ownerId: owner.userId,
      fileId: file.id,
      tokenHash: token.hash,
      passwordHash,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    }).returning({ id: shares.id });
    return jsonResponse({ id: created.id, url: `${env.APP_ORIGIN}/share/${token.raw}`, expiresInDays: days }, { status: 201 });
  });
}
