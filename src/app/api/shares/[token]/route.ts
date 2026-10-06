import { withConnection } from "@/lib/storage-context";
import { z } from "zod";
import { handleRoute, readJson } from "@/lib/http";
import { consumeSharedRateLimit, requestClientKey } from "@/lib/rate-limit";
import { parseOrBad } from "@/lib/validation";
import { verifySharePassword, hashShareToken, shareUrlTtlSeconds } from "@/lib/share";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";
import { presignGet } from "@/lib/storage";
import { getActiveShare, grantShareAccess, hasShareAccess, shareFiles, shareMetadata } from "@/lib/share-access";
import { streamPreview } from "@/lib/preview-stream";
export const runtime = "nodejs";
type Context = { params: Promise<{ token: string }> };
export async function GET(request: Request, context: Context) {
  return handleRoute(async () => {
    const active = await getActiveShare((await context.params).token);
    const params = new URL(request.url).searchParams;
    const action = params.get("action");
    const allowed = await hasShareAccess(active);
    if (!action) {
      if (!allowed) return jsonResponse({ requiresPassword: true, name: active.name, kind: active.kind, expiresAt: active.share.expiresAt });
      return jsonResponse(await shareMetadata(active));
    }
    assertSameOrigin(request);
    if (!allowed) throw new HttpError(401, "Unlock this share to continue", "share_password_required");
    if (!["preview", "download"].includes(action)) throw new HttpError(400, "Unknown share action", "invalid_action");
    const id = parseOrBad(z.string().uuid(), params.get("fileId"));
    const file = (await shareFiles(active)).find(file => file.id === id);
    if (!file) throw new HttpError(404, "File is not part of this share", "share_file_unavailable");
    return withConnection(active.storageId, active.share.ownerId, async () => {
      const signed = await presignGet(file.objectKey, file.name, shareUrlTtlSeconds(active.share.expiresAt));
      return action === "preview" ? streamPreview(request, file.name, signed.url) : jsonResponse(signed);
    });
  });
}
export async function POST(request: Request, context: Context) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const token = (await context.params).token;
    const active = await getActiveShare(token);
    if (await hasShareAccess(active)) return jsonResponse(await shareMetadata(active));
    const rate = await consumeSharedRateLimit(`share-password:${hashShareToken(token)}:${requestClientKey(request)}`, 5, 15 * 60_000);
    if (!rate.allowed) throw new HttpError(429, "Too many password attempts. Try again in 15 minutes.", "share_rate_limited");
    const { password } = parseOrBad(z.object({ password: z.string().min(1).max(128) }), await readJson(request));
    if (!(await verifySharePassword(password, active.share.passwordHash!))) throw new HttpError(401, "Incorrect share password", "share_password_invalid");
    await grantShareAccess(active);
    return jsonResponse(await shareMetadata(active));
  });
}
