import { isSafeObjectKey, type FileState } from "./state";

export type ManagedStorageObject = {
  objectKey: string;
  status: FileState;
};

export type ListedStorageObject = {
  objectKey: string;
  size: number;
  etag?: string;
};

export type ReconciliationReport = {
  missingManagedKeys: string[];
  untrackedProviderKeys: string[];
  invalidManagedKeys: string[];
  // Deliberately empty: a bucket-root listing may contain another project's
  // data. Untracked objects require an explicit, separately reviewed action.
  automaticDeleteKeys: [];
};

const providerBackedStates: ReadonlySet<FileState> = new Set(["uploading", "ready", "trashed", "purge_pending"]);

export function buildReconciliationReport(input: {
  managed: readonly ManagedStorageObject[];
  provider: readonly ListedStorageObject[];
}): ReconciliationReport {
  const managedKeys = new Set(
    input.managed.filter((object) => providerBackedStates.has(object.status)).map((object) => object.objectKey)
  );
  const invalidManagedKeys = input.managed
    .filter((object) => !isSafeObjectKey(object.objectKey))
    .map((object) => object.objectKey);
  const providerKeys = new Set(input.provider.map((object) => object.objectKey));

  return {
    missingManagedKeys: [...managedKeys].filter((key) => !providerKeys.has(key)).sort(),
    untrackedProviderKeys: [...providerKeys].filter((key) => !managedKeys.has(key)).sort(),
    invalidManagedKeys: [...new Set(invalidManagedKeys)].sort(),
    automaticDeleteKeys: []
  };
}

export function planOwnedPurgeDeletes(managed: readonly ManagedStorageObject[]): string[] {
  return [...new Set(managed
    .filter((object) => object.status === "purge_pending" && isSafeObjectKey(object.objectKey))
    .map((object) => object.objectKey))].sort();
}
