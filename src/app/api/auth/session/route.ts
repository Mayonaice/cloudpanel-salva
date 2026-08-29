import { getSession } from "@/lib/auth";
import { jsonResponse } from "@/lib/security";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  return jsonResponse({ authenticated: Boolean(session), session });
}
