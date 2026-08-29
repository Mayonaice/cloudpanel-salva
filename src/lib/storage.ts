import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
  type CompletedPart
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomBytes } from "node:crypto";
import { getEnv } from "./env";
import { connectionClient, currentStorage } from "./storage-context";
import { nasControl, NasStorageProvider } from "./nas-provider";
import { HttpError } from "./security";
import { isStoredObjectKey } from "./bucket-key";
import { boundedTransferExpiry, type MultipartCompletion, type MultipartPart, type StorageCapabilities, type StorageObject, type StorageProvider, type StoredObjectHead } from "./storage-provider";

const S3_CAPABILITIES: StorageCapabilities = Object.freeze({
  presignedPut: true,
  presignedGet: true,
  multipart: true,
  head: true,
  range: true,
  delete: true,
  checksumSha256: false, // SumoPod accepts SHA256 PUT but does not expose it on HEAD.
  list: true
});

function assertStorageReady(): void { currentStorage(); }
export function requireStorageReady(): void { assertStorageReady(); }
function getClient() { return connectionClient(); }
function bucket(): string { return currentStorage().connection.bucket!; }
function providerKey(key: string) { return currentStorage().connection.prefix + key; }
function relativeKey(key: string) { return key.slice(currentStorage().connection.prefix.length); }

function assertObjectKey(objectKey: string): void {
  if (!isStoredObjectKey(objectKey)) throw new Error("Invalid provider object key");
}

function assertMultipartPart(partNumber: number): void {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new Error("Invalid multipart part");
}

function assertMultipartParts(parts: MultipartPart[]): void {
  if (parts.length === 0 || new Set(parts.map((part) => part.partNumber)).size !== parts.length) throw new Error("Multipart completion requires unique parts");
  for (const part of parts) {
    assertMultipartPart(part.partNumber);
    if (!part.etag || part.etag.length > 256) throw new Error("Invalid multipart ETag");
  }
}

function safeDisposition(fileName: string): string {
  return fileName.replace(/[\r\n"\\/]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 255) || "download";
}

function checksumHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return Buffer.from(value, "base64").toString("hex");
  } catch {
    return undefined;
  }
}

class S3StorageProvider implements StorageProvider {
  readonly name = "s3-compatible";
  readonly capabilities = S3_CAPABILITIES;

  async createPresignedPut(input: { objectKey: string; contentType: string }): Promise<{ url: string; expiresIn: number }> {
    assertObjectKey(input.objectKey);
    const expiresIn = 300;
    const url = await getSignedUrl(getClient(), new PutObjectCommand({
      Bucket: bucket(),
      Key: providerKey(input.objectKey),
      ContentType: input.contentType
    }), { expiresIn });
    return { url, expiresIn };
  }

  async createPresignedGet(input: { objectKey: string; fileName: string; expiresIn?: number }): Promise<{ url: string; expiresIn: number }> {
    if (!isStoredObjectKey(input.objectKey)) throw new Error("Invalid stored object key");
    const expiresIn = boundedTransferExpiry(input.expiresIn);
    const url = await getSignedUrl(getClient(), new GetObjectCommand({
      Bucket: bucket(),
      Key: providerKey(input.objectKey),
      ResponseContentDisposition: `attachment; filename="${safeDisposition(input.fileName).replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safeDisposition(input.fileName)).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
      ResponseContentType: "application/octet-stream"
    }), { expiresIn });
    return { url, expiresIn };
  }

  async createMultipart(input: { objectKey: string; contentType: string }): Promise<{ uploadId: string }> {
    assertObjectKey(input.objectKey);
    const response = await getClient().send(new CreateMultipartUploadCommand({
      Bucket: bucket(),
      Key: providerKey(input.objectKey),
      ContentType: input.contentType
    }));
    if (!response.UploadId) throw new Error("Provider did not return a multipart upload id");
    return { uploadId: response.UploadId };
  }

  async createPresignedPart(input: { objectKey: string; uploadId: string; partNumber: number }): Promise<{ url: string; expiresIn: number }> {
    assertObjectKey(input.objectKey);
    if (!input.uploadId) throw new Error("Invalid multipart upload id");
    assertMultipartPart(input.partNumber);
    const expiresIn = 300;
    const url = await getSignedUrl(getClient(), new UploadPartCommand({
      Bucket: bucket(),
      Key: providerKey(input.objectKey),
      UploadId: input.uploadId,
      PartNumber: input.partNumber
    }), { expiresIn });
    return { url, expiresIn };
  }

  async completeMultipart(input: { objectKey: string; uploadId: string; parts: MultipartPart[] }): Promise<MultipartCompletion> {
    assertObjectKey(input.objectKey);
    if (!input.uploadId) throw new Error("Invalid multipart upload id");
    assertMultipartParts(input.parts);
    const completed: CompletedPart[] = [...input.parts]
      .sort((left, right) => left.partNumber - right.partNumber)
      .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag }));
    await getClient().send(new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: providerKey(input.objectKey),
      UploadId: input.uploadId,
      MultipartUpload: { Parts: completed }
    }));
    // CompleteMultipartUpload does not return the object size. Read the
    // provider's authoritative metadata before handing control back to the
    // upload finalizer.
    return this.headObject(input.objectKey);
  }

  async abortMultipart(input: { objectKey: string; uploadId: string }): Promise<void> {
    assertObjectKey(input.objectKey);
    if (!input.uploadId) throw new Error("Invalid multipart upload id");
    try {
      await getClient().send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: providerKey(input.objectKey), UploadId: input.uploadId }));
    } catch (error) {
      // Retrying cleanup after a successful abort must remain idempotent.
      if (!(error instanceof Error) || error.name !== "NoSuchUpload") throw error;
    }
  }

  async headObject(objectKey: string): Promise<StoredObjectHead> {
    if (!isStoredObjectKey(objectKey)) throw new Error("Invalid stored object key");
    const result = await getClient().send(new HeadObjectCommand({ Bucket: bucket(), Key: providerKey(objectKey), ChecksumMode: "ENABLED" }));
    return {
      size: Number(result.ContentLength ?? 0),
      etag: result.ETag,
      checksum: checksumHex(result.ChecksumSHA256)
    };
  }

  async deleteObject(objectKey: string): Promise<void> {
    if (!isStoredObjectKey(objectKey)) throw new Error("Invalid stored object key");
    await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: providerKey(objectKey) }));
  }

  async listObjects(input: { continuationToken?: string } = {}): Promise<{ objects: StorageObject[]; continuationToken?: string }> {
    const result = await getClient().send(new ListObjectsV2Command({
      Bucket: bucket(),
      Prefix: currentStorage().connection.prefix,
      ContinuationToken: input.continuationToken,
      MaxKeys: 1000
    }));
    const objects = (result.Contents ?? []).flatMap((item): StorageObject[] => {
      if (!item.Key) return [];
      return [{ objectKey: relativeKey(item.Key), size: Number(item.Size ?? 0), etag: item.ETag }];
    });
    return { objects, ...(result.NextContinuationToken ? { continuationToken: result.NextContinuationToken } : {}) };
  }
}

export function getStorageProvider(): StorageProvider {
  assertStorageReady();
  return currentStorage().connection.kind === "s3" ? new S3StorageProvider() : new NasStorageProvider();
}

export function createOpaqueObjectKey(): string {
  // Deliberately root-scoped: cloud-salvaweb ignores the old salvaweb S3_PREFIX.
  return randomBytes(32).toString("hex");
}

export async function storedObjectExists(key: string): Promise<boolean> {
  try { await headObject(key); return true; }
  catch (error) {
    if (error instanceof HttpError && error.status === 404) return false;
    if (error && typeof error === "object" && "$metadata" in error && (error.$metadata as { httpStatusCode?: number })?.httpStatusCode === 404) return false;
    throw error;
  }
}

export async function createFolderMarker(path: string): Promise<void> {
  if (!path.endsWith("/") || !isStoredObjectKey(path.slice(0, -1))) throw new Error("Invalid folder path");
  if (currentStorage().connection.kind !== "s3") { await nasControl("mkdir", { key: path }); return; }
  try {
    await getClient().send(new PutObjectCommand({ Bucket: bucket(), Key: providerKey(path), Body: new Uint8Array(0), ContentLength: 0, ContentType: "application/x-directory", IfNoneMatch: "*" }));
  } catch (error) {
    if (error && typeof error === "object" && "$metadata" in error && (error.$metadata as { httpStatusCode?: number })?.httpStatusCode === 412) return;
    throw error;
  }
}

export async function deleteEmptyFolderMarker(path: string): Promise<void> {
  if (!path.endsWith("/") || !isStoredObjectKey(path.slice(0, -1))) throw new Error("Invalid folder path");
  if (currentStorage().connection.kind !== "s3") { await nasControl("rmdir", { key: path }); return; }
  const listed = await getClient().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: providerKey(path), MaxKeys: 2 }));
  if ((listed.Contents ?? []).some((object) => object.Key !== providerKey(path)) || listed.IsTruncated) throw new HttpError(409, "Only empty folders can be renamed", "folder_not_empty");
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket(), Key: providerKey(path) }));
}

export async function presignSinglePut(objectKey: string, contentType: string): Promise<{ url: string; expiresIn: number }> {
  return getStorageProvider().createPresignedPut({ objectKey, contentType });
}

export async function presignGet(objectKey: string, fileName: string, expiresIn?: number): Promise<{ url: string; expiresIn: number }> {
  return getStorageProvider().createPresignedGet({ objectKey, fileName, expiresIn });
}

export async function createMultipart(objectKey: string, contentType: string): Promise<{ uploadId: string }> {
  return getStorageProvider().createMultipart({ objectKey, contentType });
}

export async function presignMultipartPart(objectKey: string, uploadId: string, partNumber: number): Promise<{ url: string; expiresIn: number }> {
  return getStorageProvider().createPresignedPart({ objectKey, uploadId, partNumber });
}

export async function completeMultipart(objectKey: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<MultipartCompletion> {
  return getStorageProvider().completeMultipart({ objectKey, uploadId, parts });
}

export async function abortMultipart(objectKey: string, uploadId: string): Promise<void> {
  return getStorageProvider().abortMultipart({ objectKey, uploadId });
}

export async function headObject(objectKey: string): Promise<{ size: number; etag?: string; checksum?: string }> {
  return getStorageProvider().headObject(objectKey);
}

export async function deleteObject(objectKey: string): Promise<void> {
  return getStorageProvider().deleteObject(objectKey);
}

export async function listBucket(continuationToken?: string) {
  assertStorageReady();
  if (currentStorage().connection.kind !== "s3") {
    const result = await getStorageProvider().listObjects({ continuationToken });
    return { Contents: result.objects.map((item) => ({ Key: item.objectKey, Size: item.size, LastModified: undefined as Date | undefined })), NextContinuationToken: result.continuationToken, IsTruncated: !!result.continuationToken };
  }
  const result = await getClient().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: currentStorage().connection.prefix, ContinuationToken: continuationToken, MaxKeys: 1000 }));
  return { ...result, Contents: result.Contents?.map((item) => ({ ...item, Key: item.Key ? relativeKey(item.Key) : undefined })) };
}

export async function listMultipartUploads(keyMarker?: string, uploadIdMarker?: string) {
  assertStorageReady();
  return getClient().send(new ListMultipartUploadsCommand({ Bucket: bucket(), Prefix: currentStorage().connection.prefix, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker, MaxUploads: 1000 }));
}

export function storageLimits() {
  const env = getEnv();
  return {
    maxFileBytes: env.MAX_FILE_BYTES,
    singlePutBytes: env.SINGLE_PUT_BYTES,
    partBytes: env.MULTIPART_PART_BYTES,
    concurrency: env.MULTIPART_CONCURRENCY
  };
}
