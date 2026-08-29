import { completeGoogleLogin, OAUTH_NONCE_COOKIE, OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE, setSessionCookie } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { errorResponse, HttpError } from "@/lib/security";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) throw new HttpError(400, "Missing OAuth callback parameters", "oauth_callback_invalid");
    const session = await completeGoogleLogin(code, state);
    await setSessionCookie(session);
    const response = NextResponse.redirect(new URL("/", getEnv().APP_ORIGIN));
    response.cookies.set(OAUTH_STATE_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
    response.cookies.set(OAUTH_VERIFIER_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
    response.cookies.set(OAUTH_NONCE_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
