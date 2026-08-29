import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key() {
  const key = Buffer.from(process.env.STORAGE_ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("Storage encryption key is not configured");
  return key;
}
export function encryptCredentials(value: unknown, connectionId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(connectionId));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}
export function decryptCredentials<T>(encoded: string, connectionId: string): T {
  const [version, iv, tag, body] = encoded.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Invalid encrypted storage credentials");
  const cipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  cipher.setAAD(Buffer.from(connectionId));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(body, "base64url")), cipher.final()]).toString("utf8")) as T;
}
