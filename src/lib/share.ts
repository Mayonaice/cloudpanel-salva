import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

export function createShareToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashShareToken(raw) };
}

export function hashShareToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function isShareToken(value: string): boolean {
  // Tokens are 32 random bytes encoded as base64url (43 characters). Reject
  // oversized or path-like input before hashing it or touching the database.
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export async function hashSharePassword(password: string): Promise<string> {
  // bcrypt only reads 72 bytes; prehash so long Unicode passwords stay distinct.
  return `sha256:${await bcrypt.hash(createHash("sha256").update(password).digest("base64"), 12)}`;
}

export async function verifySharePassword(password: string, hash: string): Promise<boolean> {
  if (hash.startsWith("sha256:")) return bcrypt.compare(createHash("sha256").update(password).digest("base64"), hash.slice(7));
  return bcrypt.compare(password, hash);
}

export function shareUrlTtlSeconds(expiresAt: Date, now = Date.now()): number {
  return Math.max(1, Math.min(300, Math.floor((expiresAt.getTime() - now) / 1000)));
}
