import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketEntry, isStoredObjectKey } from "../src/lib/bucket-key";
import { isSafeObjectKey } from "../src/lib/state";
import { namedObjectKey, resolveFolderPath } from "../src/lib/storage-path";

test("import supports existing nested keys but upload keys remain opaque", () => {
  assert.deepEqual(bucketEntry("Salvaweb/Photos/日本語.png"), { marker: false, directories: ["Salvaweb", "Photos"], name: "日本語.png" });
  assert.deepEqual(bucketEntry("Linia/"), { marker: true, directories: ["Linia"], name: "Linia" });
  assert.equal(isSafeObjectKey("Salvaweb/photo.png"), false);
  assert.equal(isStoredObjectKey("a".repeat(64)), true);
});
test("stored keys reject ambiguous paths and control characters", () => {
  for (const key of ["", "/root", "../a", "a/../b", "a//b", "a/./b", "a\\b", "a\u0000b", "a/", "é".repeat(513)]) assert.equal(isStoredObjectKey(key), false, key);
});
test("named uploads preserve folders, extensions, unicode and collision suffixes", () => {
  const tree = [{ id: "parent", parentId: null, name: "Videos", storagePath: null }, { id: "child", parentId: "parent", name: "OSU!", storagePath: null }];
  assert.equal(resolveFolderPath(tree, "child"), "Videos/OSU!/");
  assert.equal(namedObjectKey(resolveFolderPath(tree, "child"), "aaa.mp4"), "Videos/OSU!/aaa.mp4");
  assert.equal(namedObjectKey("OSU!/", "aaa.mp4", "unique"), "OSU!/aaa (unique).mp4");
  assert.equal(namedObjectKey("", "日本語.mp4"), "日本語.mp4");
  assert.throws(() => namedObjectKey("", "../escape.mp4"));
  assert.throws(() => resolveFolderPath(tree, "missing"));
  assert.throws(() => resolveFolderPath([{ id: "cycle", name: "cycle", parentId: "cycle", storagePath: null }], "cycle"));
});
