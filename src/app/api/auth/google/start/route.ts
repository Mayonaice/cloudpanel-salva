import { startGoogleLogin } from "@/lib/auth";
import { isGoogleAuthConfigured } from "@/lib/env";
import { handleRoute } from "@/lib/http";
import { HttpError } from "@/lib/security";

export const runtime = "nodejs";

export async function GET() {
  return handleRoute(async () => {
    if (!isGoogleAuthConfigured()) throw new HttpError(503, "Owner sign-in is not configured yet", "auth_not_configured");
    return startGoogleLogin();
  });
}
