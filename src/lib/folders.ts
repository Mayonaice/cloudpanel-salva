import { tenantScope, storageId } from "./storage-context";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { files, folders, users } from "./db/schema";
import { HttpError, normalizeFileName } from "./security";
import { createFolderMarker, deleteEmptyFolderMarker } from "./storage";
import { namedObjectKey, resolveFolderPath } from "./storage-path";

export async function createFolder(ownerId: string, name: string, parentId?: string | null) {
  const cleanName = normalizeFileName(name);
  return getDb().transaction(async (tx) => {
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for("update");
    if (!owner) throw new HttpError(401, "Owner not found", "owner_not_found");
    const owned = await tx.select().from(folders).where(tenantScope(folders, ownerId));
    if (owned.some((folder) => folder.parentId === (parentId ?? null) && folder.name.toLowerCase() === cleanName.toLowerCase())) throw new HttpError(409, "A folder with that name already exists", "folder_name_conflict");
    const storagePath = `${namedObjectKey(resolveFolderPath(owned, parentId ?? null), cleanName)}/`;
    await createFolderMarker(storagePath);
    const [folder] = await tx.insert(folders).values({ storageId: storageId(), ownerId, name: cleanName, parentId: parentId ?? null, storagePath }).returning();
    return folder;
  });
}

export async function getOwnedFolder(ownerId: string, folderId: string) {
  const [folder] = await getDb().select().from(folders).where(and(tenantScope(folders, ownerId), eq(folders.id, folderId))).limit(1);
  if (!folder) throw new HttpError(404, "Folder not found", "folder_not_found");
  return folder;
}

export async function updateFolder(ownerId: string, folderId: string, changes: { name?: string; parentId?: string | null }) {
  return getDb().transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for("update");
    const owned = await tx.select().from(folders).where(tenantScope(folders, ownerId));
    const folder = owned.find((item) => item.id === folderId);
    if (!folder) throw new HttpError(404, "Folder not found", "folder_not_found");
    const parentId = changes.parentId === undefined ? folder.parentId : changes.parentId;
    const name = changes.name === undefined ? folder.name : normalizeFileName(changes.name);
    if (parentId === folder.parentId && name === folder.name) return folder;
    if (parentId === folderId) throw new HttpError(409, "Folder cannot contain itself", "folder_cycle");
    if (owned.some((item) => item.id !== folderId && item.parentId === parentId && item.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "A folder with that name already exists", "folder_name_conflict");
    const [contained] = await tx.select({ id: files.id }).from(files).where(and(eq(files.folderId, folderId), tenantScope(files, ownerId), inArray(files.status, ["uploading", "ready", "trashed", "purge_pending"]))).limit(1);
    if (contained || owned.some((item) => item.parentId === folderId)) throw new HttpError(409, "Only empty folders can be renamed or moved. Existing contents are kept safely in place.", "folder_not_empty");
    const oldPath = resolveFolderPath(owned, folderId);
    const storagePath = `${namedObjectKey(resolveFolderPath(owned, parentId), name)}/`;
    // Check provider contents too: metadata alone is not authoritative for emptiness.
    await deleteEmptyFolderMarker(oldPath);
    try { await createFolderMarker(storagePath); }
    catch (error) { await createFolderMarker(oldPath); throw error; }
    const [updated] = await tx.update(folders).set({ name, parentId, storagePath, updatedAt: new Date() }).where(eq(folders.id, folderId)).returning();
    return updated;
  });
}

export async function wouldCreateCycle(ownerId: string, folderId: string, newParentId: string | null): Promise<boolean> {
  const owned = await getDb().select().from(folders).where(tenantScope(folders, ownerId));
  const seen = new Set<string>();
  let current = newParentId;
  while (current) {
    if (current === folderId || seen.has(current)) return true;
    seen.add(current);
    const folder = owned.find((item) => item.id === current);
    if (!folder) throw new HttpError(404, "Destination folder not found", "folder_not_found");
    current = folder.parentId;
  }
  return false;
}
