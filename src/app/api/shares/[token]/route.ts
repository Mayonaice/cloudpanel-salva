import { withConnection } from "@/lib/storage-context";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { files, shares } from "@/lib/db/schema";
import { handleRoute, readJson } from "@/lib/http";
import { consumeSharedRateLimit, requestClientKey } from "@/lib/rate-limit";
import { parseOrBad } from "@/lib/validation";
import { verifySharePassword, hashShareToken, isShareToken, shareUrlTtlSeconds } from "@/lib/share";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";
import { presignGet } from "@/lib/storage";

export const runtime = "nodejs";

type Context = { params: Promise<{ token: string }> };
const passwordSchema = z.object({ password: z.string().min(1).max(128).optional() });

async function getShare(token: string) {
  if (!isShareToken(token)) throw new HttpError(404, "Share link is unavailable", "share_unavailable");
  const [match] = await getDb().select({ share: shares, file: files }).from(shares).innerJoin(files, eq(files.id, shares.fileId))
    .where(and(eq(shares.tokenHash, hashShareToken(token)), isNull(shares.revokedAt))).limit(1);
  if (!match || match.share.expiresAt.getTime() <= Date.now() || match.file.status !== "ready" || match.file.trashedAt) {
    throw new HttpError(404, "Share link is unavailable", "share_unavailable");
  }
  return match;
}

async function getPublicShare(token: string) {
  const share = await getShare(token);
  if (share.share.passwordHash) return jsonResponse({ requiresPassword: true, name: share.file.name, expiresAt: share.share.expiresAt });
  const signed = await withConnection(share.file.storageId, share.file.ownerId, () => presignGet(share.file.objectKey, share.file.name, shareUrlTtlSeconds(share.share.expiresAt)));
  return jsonResponse({ requiresPassword: false, name: share.file.name, url: signed.url, expiresIn: signed.expiresIn });
}

export async function GET(request: Request, context: Context) {
  return handleRoute(async () => getPublicShare((await context.params).token));
}

export async function POST(request: Request, context: Context) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const token = (await context.params).token;
    if (!isShareToken(token)) throw new HttpError(404, "Share link is unavailable", "share_unavailable");
    const rate = await consumeSharedRateLimit(`share-password:${hashShareToken(token)}:${requestClientKey(request)}`, 5, 15 * 60 * 1000);
    if (!rate.allowed) throw new HttpError(429, "Too many password attempts", "share_rate_limited");
    const share = await getShare(token);
    if (!share.share.passwordHash) return getPublicShare(token);
    const { password } = parseOrBad(passwordSchema, await readJson(request));
    if (!password || !(await verifySharePassword(password, share.share.passwordHash))) {
      throw new HttpError(401, "Incorrect share password", "share_password_invalid");
    }
    const signed = await withConnection(share.file.storageId, share.file.ownerId, () => presignGet(share.file.objectKey, share.file.name, shareUrlTtlSeconds(share.share.expiresAt)));
    return jsonResponse({ requiresPassword: false, name: share.file.name, url: signed.url, expiresIn: signed.expiresIn });
  });
}
