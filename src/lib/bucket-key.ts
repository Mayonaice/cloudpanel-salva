// Used only for keys read from the provider and persisted in owned metadata.
// New uploads must still use random opaque keys, never user supplied paths.
export function isStoredObjectKey(key: string): boolean {
  return key.length > 0 && Buffer.byteLength(key, "utf8") <= 1024
    && !/[\x00-\x1f\x7f\\]/.test(key)
    && !key.startsWith("/") && !key.endsWith("/")
    && key.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function bucketEntry(key: string) {
  const marker = key.endsWith("/");
  const path = marker ? key.slice(0, -1) : key;
  if (!isStoredObjectKey(path)) return null;
  const segments = path.split("/");
  return { marker, directories: marker ? segments : segments.slice(0, -1), name: segments.at(-1)! };
}
