import { z } from "zod";
import { getEnv } from "./env";
import { HttpError, normalizeContentType, normalizeFileName } from "./security";

export const fileIdSchema = z.string().uuid();
export const folderIdSchema = z.string().uuid().nullable().optional();

export const createUploadSchema = z.object({
  name: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().optional(),
  folderId: folderIdSchema,
  idempotencyKey: z.string().min(16).max(200)
});

export const completeUploadSchema = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1).max(256) })).max(10000).default([])
});

export const updateFileSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  folderId: folderIdSchema
}).refine((value) => value.name !== undefined || value.folderId !== undefined, "At least one field is required");

export function parseOrBad<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Request validation failed", "validation_failed");
  return parsed.data;
}

export function validateUploadInput(input: z.infer<typeof createUploadSchema>) {
  const env = getEnv();
  const name = normalizeFileName(input.name);
  if (input.sizeBytes > env.MAX_FILE_BYTES) throw new HttpError(413, "File exceeds the configured maximum", "file_too_large");
  if (input.sizeBytes > Number.MAX_SAFE_INTEGER) throw new HttpError(400, "File size is invalid", "invalid_size");
  return { ...input, name, contentType: normalizeContentType(input.contentType) };
}
