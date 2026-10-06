import { and, desc, eq } from "drizzle-orm";
import { requireWriteAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { files, folders, shares, storageConnections } from "@/lib/db/schema";
import { decryptCredentials } from "@/lib/credential-vault";
import { getEnv } from "@/lib/env";
import { handleRoute } from "@/lib/http";
import { assertSameOrigin, jsonResponse } from "@/lib/security";
import { canRevealSharePassword } from "@/lib/share-policy";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const owner = await requireWriteAccess();
    const canRevealPassword = canRevealSharePassword(owner.role);
    const results = await getDb().select({ share: shares, fileName: files.name, folderName: folders.name, storageId: files.storageId, fileStatus: files.status, trashedAt: files.trashedAt }).from(shares)
      .leftJoin(files, and(eq(files.id, shares.fileId), eq(files.ownerId, shares.ownerId)))
      .leftJoin(folders, and(eq(folders.id, shares.folderId), eq(folders.ownerId, shares.ownerId)))
      .where(eq(shares.ownerId, owner.userId)).orderBy(desc(shares.createdAt));
    const ownedFolders = await getDb().select({ id: folders.id, storageId: folders.storageId }).from(folders).where(eq(folders.ownerId, owner.userId));
    const storages = await getDb().select({ id: storageConnections.id, name: storageConnections.name, disconnectedAt: storageConnections.disconnectedAt }).from(storageConnections).where(eq(storageConnections.ownerId, owner.userId));
    return jsonResponse({ canRevealPassword, links: results.map(({ share, fileName, folderName, storageId, fileStatus, trashedAt }) => {
      const storage = storages.find(storage => storage.id === (share.folderId ? ownedFolders.find(folder => folder.id === share.folderId)?.storageId : storageId));
      const token = share.tokenCiphertext ? decryptCredentials<{ token: string }>(share.tokenCiphertext, `share-token:${share.id}`).token : null;
      return { id: share.id, kind: share.folderId ? "folder" : "file", name: folderName ?? fileName ?? "Unavailable target", storageName: storage?.name, expiresAt: share.expiresAt, revokedAt: share.revokedAt, createdAt: share.createdAt, passwordProtected: Boolean(share.passwordHash), unavailable: !storage || Boolean(storage.disconnectedAt) || (!share.folderId && (fileStatus !== "ready" || Boolean(trashedAt))), url: token ? `${getEnv().APP_ORIGIN}/share/${token}` : null,
        ...(canRevealPassword ? { password: share.passwordCiphertext ? decryptCredentials<{ password: string }>(share.passwordCiphertext, `share-password:${share.id}`).password : null } : {}) };
    }) });
  });
}
