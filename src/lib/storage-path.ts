import { isStoredObjectKey } from "./bucket-key";
import { HttpError, normalizeFileName } from "./security";

type FolderPath = { id: string; parentId: string | null; name: string; storagePath: string | null };
export function resolveFolderPath(folders: FolderPath[], folderId: string | null): string {
  if (!folderId) return "";
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: string | null = folderId;
  while (current) {
    if (seen.has(current)) throw new HttpError(409, "Folder cycle detected", "folder_cycle");
    seen.add(current);
    const folder = folders.find((item) => item.id === current);
    if (!folder) throw new HttpError(404, "Destination folder not found", "folder_not_found");
    if (folder.storagePath) { parts.unshift(folder.storagePath.replace(/\/$/, "")); break; }
    parts.unshift(normalizeFileName(folder.name));
    current = folder.parentId;
  }
  const path = parts.join("/");
  if (!isStoredObjectKey(path)) throw new HttpError(400, "Folder path is too long or unsupported", "invalid_path");
  return `${path}/`;
}
export function namedObjectKey(prefix: string, name: string, suffix?: string) {
  const safe = normalizeFileName(name);
  const dot = safe.lastIndexOf(".");
  const base = suffix ? dot > 0 ? `${safe.slice(0, dot)} (${suffix})${safe.slice(dot)}` : `${safe} (${suffix})` : safe;
  const key = `${prefix}${base}`;
  if (!isStoredObjectKey(key)) throw new HttpError(400, "File path is too long or unsupported", "invalid_path");
  return key;
}
