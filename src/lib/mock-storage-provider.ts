import { createHash, randomUUID } from "node:crypto";
import { boundedTransferExpiry } from "./storage-provider";
import type {
  MockStorageProvider,
  MultipartPart,
  SignedTransfer,
  StorageCapabilities,
  StorageObject,
  StorageRange,
  StoredObjectHead
} from "./storage-provider";
import { isSafeObjectKey } from "./state";

const capabilities: StorageCapabilities = {
  presignedPut: true,
  presignedGet: true,
  multipart: true,
  head: true,
  range: true,
  delete: true,
  checksumSha256: true,
  list: true
};

type ObjectRecord = {
  head: StoredObjectHead;
  body: Uint8Array;
};

type MultipartRecord = {
  objectKey: string;
  contentType: string;
  parts: Map<number, MultipartPart & { body: Uint8Array }>;
};

function assertKey(objectKey: string): void {
  if (!isSafeObjectKey(objectKey)) throw new Error("Invalid provider object key");
}

function assertPartNumber(partNumber: number): void {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new Error("Invalid multipart part number");
}

function cloneBytes(body: Uint8Array): Uint8Array {
  return new Uint8Array(body);
}

function metadata(body: Uint8Array, contentType?: string): StoredObjectHead {
  return {
    size: body.byteLength,
    etag: createHash("md5").update(body).digest("hex"),
    checksum: createHash("sha256").update(body).digest("hex"),
    ...(contentType ? { contentType } : {})
  };
}

function notFound(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "not_found";
  return error;
}

function transfer(kind: string, objectKey: string, extra = ""): SignedTransfer {
  return { url: `mock://${kind}/${objectKey}${extra ? `/${extra}` : ""}`, expiresIn: 300 };
}

export function createMockStorageProvider(): MockStorageProvider {
  const objects = new Map<string, ObjectRecord>();
  const multipart = new Map<string, MultipartRecord>();

  const provider: MockStorageProvider = {
    name: "mock",
    capabilities,

    async createPresignedPut({ objectKey }) {
      assertKey(objectKey);
      return transfer("put", objectKey);
    },

    async createPresignedGet({ objectKey, expiresIn }) {
      assertKey(objectKey);
      return { ...transfer("get", objectKey), expiresIn: boundedTransferExpiry(expiresIn) };
    },

    async createMultipart({ objectKey, contentType }) {
      assertKey(objectKey);
      const uploadId = randomUUID();
      multipart.set(uploadId, { objectKey, contentType, parts: new Map() });
      return { uploadId };
    },

    async createPresignedPart({ objectKey, uploadId, partNumber }) {
      assertKey(objectKey);
      assertPartNumber(partNumber);
      const session = multipart.get(uploadId);
      if (!session || session.objectKey !== objectKey) throw notFound("Multipart upload not found");
      return transfer("part", objectKey, `${uploadId}/${partNumber}`);
    },

    async completeMultipart({ objectKey, uploadId, parts }) {
      assertKey(objectKey);
      const session = multipart.get(uploadId);
      if (!session || session.objectKey !== objectKey) throw notFound("Multipart upload not found");
      const sorted = [...parts].sort((left, right) => left.partNumber - right.partNumber);
      if (sorted.length === 0 || new Set(sorted.map((part) => part.partNumber)).size !== sorted.length) throw new Error("Invalid multipart parts");
      const bodies: Uint8Array[] = [];
      for (const part of sorted) {
        assertPartNumber(part.partNumber);
        const stored = session.parts.get(part.partNumber);
        if (!stored || stored.etag !== part.etag) throw new Error("Multipart part is missing or has a mismatched ETag");
        bodies.push(stored.body);
      }
      const body = new Uint8Array(bodies.reduce((total, value) => total + value.byteLength, 0));
      let offset = 0;
      for (const value of bodies) {
        body.set(value, offset);
        offset += value.byteLength;
      }
      const head = metadata(body, session.contentType);
      objects.set(objectKey, { head, body });
      multipart.delete(uploadId);
      return head;
    },

    async abortMultipart({ objectKey, uploadId }) {
      assertKey(objectKey);
      const session = multipart.get(uploadId);
      if (!session || session.objectKey !== objectKey) return;
      multipart.delete(uploadId);
    },

    async putObject({ objectKey, contentType, body }) {
      assertKey(objectKey);
      const copy = cloneBytes(body);
      const head = metadata(copy, contentType);
      objects.set(objectKey, { head, body: copy });
      return head;
    },

    async getObject({ objectKey, range }) {
      assertKey(objectKey);
      const object = objects.get(objectKey);
      if (!object) throw notFound("Object not found");
      const selected = range ? selectRange(object.body, range) : object.body;
      return { body: cloneBytes(selected), head: { ...object.head, size: selected.byteLength } };
    },

    async uploadPart({ objectKey, uploadId, partNumber, body }) {
      assertKey(objectKey);
      assertPartNumber(partNumber);
      const session = multipart.get(uploadId);
      if (!session || session.objectKey !== objectKey) throw notFound("Multipart upload not found");
      const copy = cloneBytes(body);
      const part: MultipartPart & { body: Uint8Array } = {
        partNumber,
        etag: createHash("md5").update(copy).digest("hex"),
        size: copy.byteLength,
        body: copy
      };
      session.parts.set(partNumber, part);
      return { partNumber, etag: part.etag, size: part.size };
    },

    async listParts({ objectKey, uploadId }) {
      assertKey(objectKey);
      const session = multipart.get(uploadId);
      if (!session || session.objectKey !== objectKey) throw notFound("Multipart upload not found");
      return [...session.parts.values()].sort((left, right) => left.partNumber - right.partNumber).map((value) => {
        const { body, ...part } = value;
        void body;
        return part;
      });
    },

    async headObject(objectKey) {
      assertKey(objectKey);
      const object = objects.get(objectKey);
      if (!object) throw notFound("Object not found");
      return { ...object.head };
    },

    async deleteObject(objectKey) {
      assertKey(objectKey);
      objects.delete(objectKey);
    },

    async listObjects({ continuationToken } = {}) {
      const all = [...objects.entries()].sort(([left], [right]) => left.localeCompare(right));
      const start = continuationToken ? Number(continuationToken) : 0;
      if (!Number.isSafeInteger(start) || start < 0 || start > all.length) throw new Error("Invalid continuation token");
      const page = all.slice(start, start + 1000).map(([objectKey, record]): StorageObject => ({ objectKey, ...record.head }));
      return { objects: page, ...(start + page.length < all.length ? { continuationToken: String(start + page.length) } : {}) };
    }
  };

  return provider;
}

function selectRange(body: Uint8Array, range: StorageRange): Uint8Array {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= body.byteLength) {
    throw new Error("Invalid byte range");
  }
  return body.slice(range.start, range.end + 1);
}
