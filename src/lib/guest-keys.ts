import { createHash, randomBytes } from "node:crypto";
export const GUEST_KEY_PREFIX = "salva_guest_";
export function generateGuestKey() { return GUEST_KEY_PREFIX + randomBytes(48).toString("base64url"); }
export function hashGuestKey(key: string) { return createHash("sha256").update(key).digest("hex"); }
