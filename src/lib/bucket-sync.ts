import { tenantScope, storageId } from "./storage-context";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { files, folders, users, storageConnections } from "./db/schema";
import { bucketEntry } from "./bucket-key";
import { listBucket } from "./storage";
import { HttpError } from "./security";

// Import metadata only. Never move, rewrite, or delete provider objects. Existing
// metadata (including trash and tombstones) wins over the bucket snapshot.
export async function syncBucket(ownerId: string) {
  const objects: Array<{ key: string; size: number; modified?: Date }> = [];
  let continuation: string | undefined;
  do {
    const page = await listBucket(continuation);
    for (const object of page.Contents ?? []) {
      if (object.Key) objects.push({ key: object.Key, size: object.Size ?? 0, modified: object.LastModified });
    }
    continuation = page.NextContinuationToken;
    if (page.IsTruncated && !continuation) throw new HttpError(502, "Bucket returned an incomplete listing", "sync_incomplete");
    if (objects.length > 20000) throw new HttpError(409, "Bucket needs a paginated background import", "sync_limit");
  } while (continuation);

  return getDb().transaction(async (tx) => {
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for("update");
    if (!owner) throw new HttpError(404, "Owner not found", "owner_not_found");
    const known = await tx.select({ key: files.objectKey, id: files.id, status: files.status, size: files.sizeBytes }).from(files).where(eq(files.storageId, storageId()));
    const keys = new Map(known.map((file) => [file.key, file]));
    const ownedFolders = await tx.select().from(folders).where(tenantScope(folders, ownerId));
    const paths = new Map(ownedFolders.filter((folder) => folder.storagePath).map((folder) => [folder.storagePath!, folder.id]));
    let imported = 0;
    let skipped = 0;
    for (const object of objects) {
      const entry = bucketEntry(object.key);
      if (!entry) { skipped++; continue; }
      const existing = keys.get(object.key);
      if (existing) {
        // External edits can change an imported object's size, but must never
        // resurrect trashed/purged files or consume an active upload reservation.
        if (existing.status === "ready" && existing.size !== object.size) {
          await tx.update(files).set({ sizeBytes: object.size, updatedAt: new Date() }).where(and(eq(files.id, existing.id), tenantScope(files, ownerId)));
        }
        continue;
      }
      let parentId: string | null = null;
      let path = "";
      for (const name of entry.directories) {
        path += `${name}/`;
        let id = paths.get(path);
        if (!id) {
          const sibling = ownedFolders.find((folder) => folder.parentId === parentId && folder.name === name && !folder.storagePath);
          if (sibling) {
            await tx.update(folders).set({ storagePath: path }).where(eq(folders.id, sibling.id));
            sibling.storagePath = path;
            id = sibling.id;
          } else {
            const created: typeof folders.$inferSelect = (await tx.insert(folders).values({ storageId: storageId(), ownerId, parentId, name, storagePath: path }).returning())[0];
            ownedFolders.push(created);
            id = created.id;
          }
          paths.set(path, id!);
        }
        parentId = id!;
      }
      if (entry.marker) continue;
      const extension = entry.name.split(".").at(-1)?.toLowerCase();
      const mime: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg" };
      await tx.insert(files).values({ storageId: storageId(), ownerId, folderId: parentId, name: entry.name, contentType: mime[extension ?? ""] ?? "application/octet-stream", sizeBytes: object.size, objectKey: object.key, status: "ready", createdAt: object.modified, updatedAt: object.modified }).onConflictDoNothing({ target: [files.storageId, files.objectKey] });
      imported++;
    }
    const [usage] = await tx.select({ bytes: sql<string>`coalesce(sum(${files.sizeBytes}), 0)` }).from(files).where(and(tenantScope(files, ownerId), inArray(files.status, ["uploading", "ready", "trashed", "purge_pending"])));
    await tx.update(storageConnections).set({ usedBytes: Number(usage.bytes), updatedAt: new Date() }).where(eq(storageConnections.id, storageId()));
    return { imported, scanned: objects.length, skipped, syncedAt: new Date().toISOString() };
  });
}
