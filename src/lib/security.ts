import { timingSafeEqual } from "node:crypto";
import { getEnv } from "./env";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "request_error") {
    super(message);
  }
}

export function assertSameOrigin(request: Request): void {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new HttpError(403, "Cross-site requests are not allowed", "origin_forbidden");
  }
  const origin = request.headers.get("origin");
  if (!origin) return;
  let expected: URL;
  try {
    expected = new URL(getEnv().APP_ORIGIN);
  } catch {
    throw new HttpError(500, "Application origin is not configured", "configuration_error");
  }
  if (origin !== expected.origin) {
    throw new HttpError(403, "Origin is not allowed", "origin_forbidden");
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function secureHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return headers;
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = secureHeaders(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ error: error.code, message: error.message }, { status: error.status });
  }
  console.error("Unhandled API error", error instanceof Error ? error.name : "unknown");
  return jsonResponse({ error: "internal_error", message: "An unexpected error occurred" }, { status: 500 });
}

export function normalizeFileName(input: string): string {
  const canonical = input.normalize("NFKC");
  if (/[\\/\u0000-\u001f\u007f]/u.test(canonical)) {
    throw new HttpError(400, "A safe file name is required", "invalid_name");
  }
  const normalized = canonical.trim();
  if (!normalized || normalized === "." || normalized === "..") {
    throw new HttpError(400, "A safe file name is required", "invalid_name");
  }
  return normalized.slice(0, 255);
}

export function normalizeContentType(input: string | undefined): string {
  const value = (input ?? "application/octet-stream").trim().toLowerCase();
  return /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : "application/octet-stream";
}
