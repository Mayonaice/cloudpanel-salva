/**
 * Provider-neutral storage contract.
 *
 * The control plane owns metadata, authorization, and object-key generation.
 * Providers only receive an already-authorized opaque key. Keeping this seam
 * small lets M1 exercise a mock and a disposable S3-compatible endpoint
 * without making the application depend on unverified provider behavior.
 */

export type StorageCapabilities = Readonly<{
  presignedPut: boolean;
  presignedGet: boolean;
  multipart: boolean;
  head: boolean;
  range: boolean;
  delete: boolean;
  checksumSha256: boolean;
  list: boolean;
}>;

export type SignedTransfer = {
  url: string;
  expiresIn: number;
  headers?: Readonly<Record<string, string>>;
};

export function boundedTransferExpiry(expiresIn: number | undefined): number {
  if (!Number.isSafeInteger(expiresIn)) return 300;
  return Math.min(300, Math.max(1, expiresIn as number));
}

export type StoredObjectHead = {
  size: number;
  etag?: string;
  checksum?: string;
  contentType?: string;
};

export type MultipartPart = {
  partNumber: number;
  etag: string;
  size?: number;
};

// The provider must return authoritative metadata after completion. S3's
// CompleteMultipart response alone does not include size/checksum, so the
// adapter performs a HEAD before resolving this contract.
export type MultipartCompletion = StoredObjectHead;

export type StorageObject = StoredObjectHead & {
  objectKey: string;
};

export type StorageRange = {
  start: number;
  end: number;
};

export interface StorageProvider {
  readonly name: string;
  readonly capabilities: StorageCapabilities;

  createPresignedPut(input: {
    objectKey: string;
    contentType: string;
    sizeBytes?: number;
  }): Promise<SignedTransfer>;

  createPresignedGet(input: {
    objectKey: string;
    fileName: string;
    expiresIn?: number;
  }): Promise<SignedTransfer>;

  createMultipart(input: {
    objectKey: string;
    contentType: string;
  }): Promise<{ uploadId: string }>;

  createPresignedPart(input: {
    objectKey: string;
    uploadId: string;
    partNumber: number;
  }): Promise<SignedTransfer>;

  completeMultipart(input: {
    objectKey: string;
    uploadId: string;
    parts: MultipartPart[];
  }): Promise<MultipartCompletion>;

  abortMultipart(input: {
    objectKey: string;
    uploadId: string;
  }): Promise<void>;

  headObject(objectKey: string): Promise<StoredObjectHead>;
  deleteObject(objectKey: string): Promise<void>;
  listObjects(input?: { continuationToken?: string }): Promise<{ objects: StorageObject[]; continuationToken?: string }>;
}

/**
 * Direct methods are intentionally optional and are only used by the local
 * mock harness. A real provider exposes transfer URLs instead, so application
 * code never needs a provider-specific body upload API.
 */
export type MockStorageProvider = StorageProvider & {
  putObject(input: { objectKey: string; contentType: string; body: Uint8Array }): Promise<StoredObjectHead>;
  getObject(input: { objectKey: string; range?: StorageRange }): Promise<{ body: Uint8Array; head: StoredObjectHead }>;
  uploadPart(input: { objectKey: string; uploadId: string; partNumber: number; body: Uint8Array }): Promise<MultipartPart>;
  listParts(input: { objectKey: string; uploadId: string }): Promise<MultipartPart[]>;
};

export function isMockStorageProvider(provider: StorageProvider): provider is MockStorageProvider {
  return typeof (provider as Partial<MockStorageProvider>).putObject === "function"
    && typeof (provider as Partial<MockStorageProvider>).getObject === "function"
    && typeof (provider as Partial<MockStorageProvider>).uploadPart === "function"
    && typeof (provider as Partial<MockStorageProvider>).listParts === "function";
}
