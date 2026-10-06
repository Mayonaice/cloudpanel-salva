import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "./db";
import { files, folders, shares, storageConnections } from "./db/schema";
import { hashShareToken, isShareToken } from "./share";
import { HttpError } from "./security";
import { descendantFolderPaths } from "./share-policy";
import { SignJWT, jwtVerify } from "jose";
import { getSessionSecret } from "./env";
import { cookies } from "next/headers";

const unavailable = () => new HttpError(404, "Share link is unavailable", "share_unavailable");
export async function getActiveShare(token: string) {
  if (!isShareToken(token)) throw unavailable();
  const [share] = await getDb().select().from(shares).where(and(eq(shares.tokenHash, hashShareToken(token)), isNull(shares.revokedAt))).limit(1);
  if (!share || share.expiresAt.getTime() <= Date.now()) throw unavailable();
  let storageId: string, name: string;
  if (share.fileId) {
    const [file] = await getDb().select().from(files).where(and(eq(files.id, share.fileId), eq(files.ownerId, share.ownerId))).limit(1);
    if (!file || file.status !== "ready" || file.trashedAt) throw unavailable();
    storageId = file.storageId; name = file.name;
  } else if (share.folderId) {
    const [folder] = await getDb().select().from(folders).where(and(eq(folders.id, share.folderId), eq(folders.ownerId, share.ownerId))).limit(1);
    if (!folder) throw unavailable();
    storageId = folder.storageId; name = folder.name;
  } else throw unavailable();
  const [storage] = await getDb().select({ id: storageConnections.id }).from(storageConnections).where(and(eq(storageConnections.id, storageId), eq(storageConnections.ownerId, share.ownerId), isNull(storageConnections.disconnectedAt))).limit(1);
  if (!storage) throw unavailable();
  return { share, storageId, name, kind: share.folderId ? "folder" as const : "file" as const };
}
export type ActiveShare = Awaited<ReturnType<typeof getActiveShare>>;
export async function shareFiles(active: ActiveShare) {
  const scope = and(eq(files.ownerId, active.share.ownerId), eq(files.storageId, active.storageId), eq(files.status, "ready"), isNull(files.trashedAt));
  let paths = new Map<string, string>();
  if (active.share.folderId) {
    const owned = await getDb().select({ id: folders.id, parentId: folders.parentId, name: folders.name }).from(folders).where(and(eq(folders.ownerId, active.share.ownerId), eq(folders.storageId, active.storageId)));
    paths = descendantFolderPaths(owned, active.share.folderId);
  }
  const listing = await getDb().select().from(files).where(and(scope, active.share.fileId ? eq(files.id, active.share.fileId) : inArray(files.folderId, [...paths.keys()])));
  return listing.map(file => ({ ...file, path: `${file.folderId ? paths.get(file.folderId) ?? "" : ""}${file.name}` })).sort((a, b) => a.path.localeCompare(b.path));
}
export async function shareMetadata(active: ActiveShare) {
  return { name: active.name, kind: active.kind, expiresAt: active.share.expiresAt, requiresPassword: false, files: (await shareFiles(active)).map(({ id, name, path, contentType, sizeBytes }) => ({ id, name, path, contentType, sizeBytes })) };
}
const cookieName = (id: string) => `cloud_share_${id.replaceAll("-", "")}`;
export async function hasShareAccess(active: ActiveShare) {
  if (!active.share.passwordHash) return true;
  const value = (await cookies()).get(cookieName(active.share.id))?.value;
  if (!value) return false;
  try {
    const { payload } = await jwtVerify(value, getSessionSecret(), { algorithms: ["HS256"], audience: "cloud-share", subject: active.share.id });
    return payload.tokenHash === active.share.tokenHash;
  } catch { return false; }
}
export async function grantShareAccess(active: ActiveShare) {
  const maxAge = Math.max(1, Math.min(3600, Math.floor((active.share.expiresAt.getTime() - Date.now()) / 1000)));
  const value = await new SignJWT({ tokenHash: active.share.tokenHash }).setProtectedHeader({ alg: "HS256" }).setSubject(active.share.id).setAudience("cloud-share").setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + maxAge).sign(getSessionSecret());
  (await cookies()).set(cookieName(active.share.id), value, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/shares/", maxAge });
}
