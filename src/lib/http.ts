import { errorResponse, HttpError, jsonResponse } from "./security";

export async function readJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.isSafeInteger(Number(contentLength)) && Number(contentLength) > 64 * 1024) {
    throw new HttpError(413, "Request body is too large", "request_too_large");
  }
  let body: string;
  try {
    body = await request.text();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "invalid_json");
  }
  if (new TextEncoder().encode(body).byteLength > 64 * 1024) {
    throw new HttpError(413, "Request body is too large", "request_too_large");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "invalid_json");
  }
}

export function handleRoute(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch(errorResponse);
}

export { errorResponse, jsonResponse };
