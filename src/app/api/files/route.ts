import { handleStorageRoute } from "@/lib/storage-route";
import { requireSession } from "@/lib/auth";
import { failOrAbortUpload, getQuota, listFiles, listFolders, reserveUpload, setUploadProviderId, toPublicFile } from "@/lib/files";
import { readJson } from "@/lib/http";
import { abortMultipart, createMultipart, presignMultipartPart, presignSinglePut, requireStorageReady, storageLimits } from "@/lib/storage";
import { assertSameOrigin, HttpError, jsonResponse } from "@/lib/security";
import { createUploadSchema, parseOrBad, validateUploadInput } from "@/lib/validation";

export const runtime = "nodejs";

export const GET = (request: Request) => handleStorageRoute(request, async () => {
  assertSameOrigin(request);
  const session = await requireSession();
  const url = new URL(request.url);
  const folderId = url.searchParams.get("folderId");
  const search = url.searchParams.get("q") ?? undefined;
  const includeTrash = url.searchParams.get("trash") === "1";
  const [files, folders, quota] = await Promise.all([
    listFiles(session.userId, folderId, search, includeTrash),
    listFolders(session.userId, folderId),
    getQuota(session.userId)
  ]);
  return jsonResponse({ files, folders: includeTrash ? [] : folders, quota, trash: includeTrash });
});

export const POST = (request: Request) => handleStorageRoute(request, async () => {
  assertSameOrigin(request);
  const session = await requireSession();
  // Do not reserve quota or create metadata when the provider is deliberately
  // disabled. This keeps M0/M1 deployments side-effect free until the live
  // compatibility gate is explicitly opened.
  requireStorageReady();
  const input = validateUploadInput(parseOrBad(createUploadSchema, await readJson(request)));
  const limits = storageLimits();
  const reserved = await reserveUpload({
    ownerId: session.userId,
    name: input.name,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    folderId: input.folderId,
    idempotencyKey: input.idempotencyKey
  });
  const { session: upload, file } = reserved;
  if (upload.status === "completed") return jsonResponse({ mode: "completed", file: toPublicFile(file) });
  if (upload.status === "completing") throw new HttpError(409, "Upload completion is already in progress", "upload_state_conflict");
  if (upload.status === "aborted" || upload.status === "failed") {
    throw new HttpError(409, "This upload session is no longer open; retry with a new idempotency key", "upload_state_conflict");
  }

  if (input.sizeBytes <= limits.singlePutBytes) {
    try {
      const signed = await presignSinglePut(file.objectKey, file.contentType);
      return jsonResponse({ mode: "single", uploadId: upload.id, fileId: file.id, url: signed.url, expiresIn: signed.expiresIn, partBytes: null });
    } catch {
      await failOrAbortUpload(session.userId, upload.id, "failed").catch(() => undefined);
      throw new HttpError(502, "Object storage upload initialization failed", "storage_upload_init_failed");
    }
  }

  const partCount = Math.ceil(file.sizeBytes / limits.partBytes);
  if (partCount > 10000) {
    await failOrAbortUpload(session.userId, upload.id, "failed").catch(() => undefined);
    throw new HttpError(413, "Provider part-count limit exceeded", "too_many_parts");
  }
  let providerUploadId = upload.providerUploadId;
  let initializedHere = false;
  if (!providerUploadId) {
    try {
      providerUploadId = (await createMultipart(file.objectKey, file.contentType)).uploadId;
      initializedHere = true;
      const attached = await setUploadProviderId(session.userId, upload.id, providerUploadId);
      if (attached.providerUploadId !== providerUploadId) {
        // A concurrent idempotent request attached its provider upload first.
        await abortMultipart(file.objectKey, providerUploadId);
        providerUploadId = attached.providerUploadId!;
        initializedHere = false;
      }
    } catch {
      if (providerUploadId && initializedHere) {
        try {
          await abortMultipart(file.objectKey, providerUploadId);
        } catch {
          throw new HttpError(502, "Object storage cleanup failed; upload remains retryable", "storage_cleanup_failed");
        }
      }
      await failOrAbortUpload(session.userId, upload.id, "failed");
      throw new HttpError(502, "Object storage multipart initialization failed", "storage_multipart_init_failed");
    }
  }
  try {
    const firstPart = await presignMultipartPart(file.objectKey, providerUploadId, 1);
    return jsonResponse({ mode: "multipart", uploadId: upload.id, fileId: file.id, partBytes: limits.partBytes, partCount, concurrency: limits.concurrency, firstPartUrl: firstPart.url, expiresIn: firstPart.expiresIn });
  } catch {
    if (initializedHere) {
      try {
        await abortMultipart(file.objectKey, providerUploadId);
      } catch {
        // Keep the DB session open when provider cleanup fails. The caller can
        // retry the same idempotent request and resume the known multipart
        // upload instead of creating a false-clean failed record.
        throw new HttpError(502, "Object storage cleanup failed; upload remains retryable", "storage_cleanup_failed");
      }
      await failOrAbortUpload(session.userId, upload.id, "failed");
    }
    throw new HttpError(502, "Object storage part signing failed", "storage_part_sign_failed");
  }
});
