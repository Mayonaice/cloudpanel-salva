import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { shares } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { getOwnedFile } from "@/lib/files";
import { getOwnedFolder } from "@/lib/folders";
import { encryptCredentials } from "@/lib/credential-vault";
import { randomUUID } from "node:crypto";
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
  const params = new URL(request.url).searchParams;
  const fileId = params.get("fileId"), folderId = params.get("folderId");
  if (fileId) await getOwnedFile(owner.userId, parseOrBad(z.string().uuid(), fileId));
  else await getOwnedFolder(owner.userId, parseOrBad(z.string().uuid(), folderId));
  const links = await getDb().select({ id: shares.id, expiresAt: shares.expiresAt, revokedAt: shares.revokedAt, createdAt: shares.createdAt, passwordProtected: isNotNull(shares.passwordHash) }).from(shares).where(and(eq(shares.ownerId, owner.userId), fileId ? eq(shares.fileId, fileId) : eq(shares.folderId, folderId!))).orderBy(desc(shares.createdAt)).limit(100);
  return jsonResponse({ shares: links });
});
const createShareSchema = z.object({
  fileId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  expiresInDays: z.number().int().positive().optional(),
  password: z.string().min(8).max(128).optional()
}).refine(input => Boolean(input.fileId) !== Boolean(input.folderId), "Choose one file or folder");

export async function POST(request: Request) {
  return handleStorageRoute(request, async () => {
    assertSameOrigin(request);
    const owner = await requireSession();
    const input = parseOrBad(createShareSchema, await readJson(request));
    if (input.fileId) {
      const file = await getOwnedFile(owner.userId, input.fileId);
      if (file.status !== "ready" || file.trashedAt) throw new HttpError(409, "Only active files can be shared", "file_not_shareable");
    } else await getOwnedFolder(owner.userId, input.folderId!);
    const env = getEnv();
    const days = Math.min(input.expiresInDays ?? env.SHARE_DEFAULT_DAYS, env.SHARE_MAX_DAYS);
    const token = createShareToken();
    const passwordHash = input.password ? await hashSharePassword(input.password) : null;
    const id = randomUUID();
    const [created] = await getDb().insert(shares).values({
      id,
      ownerId: owner.userId,
      fileId: input.fileId ?? null,
      folderId: input.folderId ?? null,
      tokenCiphertext: encryptCredentials({ token: token.raw }, `share-token:${id}`),
      passwordCiphertext: input.password ? encryptCredentials({ password: input.password }, `share-password:${id}`) : null,
      tokenHash: token.hash,
      passwordHash,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    }).returning({ id: shares.id });
    return jsonResponse({ id: created.id, url: `${env.APP_ORIGIN}/share/${token.raw}`, expiresInDays: days }, { status: 201 });
  });
}
