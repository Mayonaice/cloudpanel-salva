import { eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { getEnv, getGoogleConfig, getSessionSecret } from "./env";
import { getDb } from "./db";
import { guestKeys, users } from "./db/schema";
import { HttpError } from "./security";

const SESSION_COOKIE = "cloud_salva_session";
const OAUTH_STATE_COOKIE = "cloud_salva_oauth_state";
const OAUTH_VERIFIER_COOKIE = "cloud_salva_oauth_verifier";
const OAUTH_NONCE_COOKIE = "cloud_salva_oauth_nonce";
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const resolveGoogleKey: JWTVerifyGetKey = (protectedHeader, token) => googleKeys(protectedHeader, token);

export type Session = {
  userId: string;
  email: string;
  displayName: string;
  authType: "owner" | "guest";
  role: "owner" | "admin" | "full" | "readonly";
  guestKeyId?: string;
};

function secureCookie() {
  return process.env.NODE_ENV === "production";
}

export async function createSession(user: Session): Promise<string> {
  return new SignJWT({ email: user.email, displayName: user.displayName, authType: user.authType, role: user.role, guestKeyId: user.guestKeyId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(getSessionSecret());
}

export async function setSessionCookie(user: Session): Promise<void> {
  const token = await createSession(user);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, secure: secureCookie(), sameSite: "lax", path: "/", maxAge: 0 });
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSessionSecret(), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.email !== "string" || typeof payload.displayName !== "string") return null;
    const [user] = await getDb().select().from(users).where(eq(users.id, payload.sub)).limit(1);
    if (!user || user.email !== payload.email) return null;
    const authType = payload.authType === "guest" ? "guest" : "owner";
    if (authType === "guest") {
      if (typeof payload.guestKeyId !== "string" || !["admin", "full", "readonly"].includes(String(payload.role))) return null;
      const [key] = await getDb().select({ id: guestKeys.id, role: guestKeys.role, revokedAt: guestKeys.revokedAt }).from(guestKeys).where(eq(guestKeys.id, payload.guestKeyId)).limit(1);
      if (!key || key.revokedAt || key.role !== payload.role) return null;
      return { userId: user.id, email: user.email, displayName: user.displayName, authType, role: key.role as "admin" | "full" | "readonly", guestKeyId: payload.guestKeyId };
    }
    return { userId: user.id, email: user.email, displayName: user.displayName, authType: "owner", role: "owner" };
  } catch {
    return null;
  }
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Authentication required", "unauthenticated");
  return session;
}

export async function requireOwner(): Promise<Session> { const session = await requireSession(); if (session.authType !== "owner") throw new HttpError(403, "Owner login required", "owner_required"); return session; }
export async function requireStorageAdmin(): Promise<Session> { const session = await requireSession(); if (!['owner','admin'].includes(session.role)) throw new HttpError(403, "Storage administration is not allowed", "forbidden"); return session; }
export async function requireWriteAccess(): Promise<Session> { const session = await requireSession(); if (session.role === "readonly") throw new HttpError(403, "This key has read-only access", "read_only"); return session; }

export async function startGoogleLogin(): Promise<NextResponse> {
  const config = getGoogleConfig();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", nonce);
  const response = NextResponse.redirect(url);
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: secureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: 600
  });
  response.cookies.set(OAUTH_VERIFIER_COOKIE, verifier, {
    httpOnly: true,
    secure: secureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: 600
  });
  response.cookies.set(OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: secureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: 600
  });
  return response;
}

export async function completeGoogleLogin(code: string, state: string): Promise<Session> {
  const cookieStore = await cookies();
  const stateCookie = cookieStore.get(OAUTH_STATE_COOKIE)?.value;
  const verifier = cookieStore.get(OAUTH_VERIFIER_COOKIE)?.value;
  const nonce = cookieStore.get(OAUTH_NONCE_COOKIE)?.value;
  if (!stateCookie || stateCookie !== state) throw new HttpError(400, "Invalid OAuth state", "oauth_state_invalid");
  if (!verifier || !nonce) throw new HttpError(400, "OAuth session expired", "oauth_session_expired");
  const config = getGoogleConfig();
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier
  });
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store"
  });
  if (!tokenResponse.ok) throw new HttpError(502, "Google token exchange failed", "oauth_exchange_failed");
  const tokenBody = (await tokenResponse.json()) as { id_token?: string };
  if (!tokenBody.id_token) throw new HttpError(502, "Google did not return an identity token", "oauth_identity_missing");

  const verified = await jwtVerify(tokenBody.id_token, resolveGoogleKey, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: config.clientId
  });
  const claims = verified.payload as JWTPayload & { email?: string; email_verified?: boolean; name?: string; nonce?: string };
  const email = claims.email?.toLowerCase();
  if (claims.nonce !== nonce) throw new HttpError(403, "Google identity nonce was invalid", "oauth_nonce_invalid");
  if (!claims.sub || !email || claims.email_verified !== true || (!getEnv().PUBLIC_REGISTRATION_ENABLED && !config.ownerEmails.includes(email))) {
    throw new HttpError(403, "This Google account is not allowed", "owner_not_allowed");
  }
  const displayName = (claims.name?.trim() || email).slice(0, 160);
  const [user] = await getDb().insert(users).values({ googleSubject: claims.sub, email, displayName }).onConflictDoUpdate({
    target: users.googleSubject,
    set: { email, updatedAt: new Date() }
  }).returning({ id: users.id, email: users.email, displayName: users.displayName });
  if (!user) throw new HttpError(500, "Could not create the owner account", "user_upsert_failed");
  return { userId: user.id, email: user.email, displayName: user.displayName, authType: "owner", role: "owner" };
}

export { SESSION_COOKIE, OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE, OAUTH_NONCE_COOKIE };
