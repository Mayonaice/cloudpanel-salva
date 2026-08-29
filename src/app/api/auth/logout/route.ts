import { clearSessionCookie } from "@/lib/auth";
import { assertSameOrigin, errorResponse, jsonResponse } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await clearSessionCookie();
    return jsonResponse({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
