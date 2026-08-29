import { z } from "zod";

const optionalString = z.string().trim().optional();

function booleanFromEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return value;
  }, z.boolean().default(defaultValue));
}

const envShape = z.object({
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  SESSION_SECRET: optionalString,
  PUBLIC_REGISTRATION_ENABLED: booleanFromEnv(false),
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_OWNER_EMAIL: optionalString,
  OWNER_EMAIL_ALLOWLIST: optionalString,
  GOOGLE_REDIRECT_URI: optionalString,
  DATABASE_URL: optionalString,
  DATABASE_SSL: booleanFromEnv(true),
  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().trim().default("us-east-1"),
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: booleanFromEnv(true),
  CRON_SECRET: optionalString,
  // These two flags are deliberately separate. Credentials alone must never
  // make a deployment call the provider before M1 compatibility evidence and
  // an explicit release decision exist.
  STORAGE_LIVE_ENABLED: booleanFromEnv(false),
  STORAGE_COMPATIBILITY_VERIFIED: booleanFromEnv(false),
  MAX_FILE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024 * 1024),
  SINGLE_PUT_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
  MULTIPART_PART_BYTES: z.coerce.number().int().positive().default(16 * 1024 * 1024),
  MULTIPART_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  TRASH_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  SHARE_DEFAULT_DAYS: z.coerce.number().int().positive().default(7),
  SHARE_MAX_DAYS: z.coerce.number().int().positive().default(30)
});

export type AppEnv = z.infer<typeof envShape>;

let cached: AppEnv | undefined;

export function getEnv(): AppEnv {
  if (!cached) {
    const parsed = envShape.safeParse(process.env);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
      throw new Error(`Invalid environment configuration: ${fields}`);
    }
    cached = parsed.data;
  }
  return cached;
}

function required(name: keyof AppEnv): string {
  const value = getEnv()[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getDatabaseConfig() {
  return {
    url: required("DATABASE_URL"),
    ssl: getEnv().DATABASE_SSL
  };
}

export function getStorageConfig() {
  const env = getEnv();
  const endpoint = required("S3_ENDPOINT");
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("S3_ENDPOINT must be a valid URL");
  }
  if (!["http:", "https:"].includes(parsedEndpoint.protocol) || parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.search || parsedEndpoint.hash) {
    throw new Error("S3_ENDPOINT must be an HTTP(S) URL without credentials or query parameters");
  }
  if (process.env.NODE_ENV === "production" && parsedEndpoint.protocol !== "https:") {
    throw new Error("S3_ENDPOINT must use HTTPS in production");
  }
  return {
    endpoint: parsedEndpoint.toString(),
    region: required("S3_REGION"),
    bucket: required("S3_BUCKET"),
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: env.S3_FORCE_PATH_STYLE
  };
}

export function isGoogleAuthConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && (env.GOOGLE_OWNER_EMAIL || env.OWNER_EMAIL_ALLOWLIST));
}

export function getGoogleConfig() {
  const env = getEnv();
  const ownerEmails = [
    ...(env.OWNER_EMAIL_ALLOWLIST ?? "").split(","),
    env.GOOGLE_OWNER_EMAIL ?? ""
  ].map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (ownerEmails.length === 0) required("GOOGLE_OWNER_EMAIL");
  return {
    clientId: required("GOOGLE_CLIENT_ID"),
    clientSecret: required("GOOGLE_CLIENT_SECRET"),
    ownerEmail: ownerEmails[0],
    ownerEmails,
    redirectUri: env.GOOGLE_REDIRECT_URI ?? `${env.APP_ORIGIN}/api/auth/google/callback`
  };
}

export function getSessionSecret(): Uint8Array {
  const secret = required("SESSION_SECRET");
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
  return new TextEncoder().encode(secret);
}

export function hasStorageConfig(): boolean {
  const env = getEnv();
  return Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
}

export function isStorageReady(input: {
  configured: boolean;
  liveEnabled: boolean;
  compatibilityVerified: boolean;
}): boolean {
  return input.configured && input.liveEnabled && input.compatibilityVerified;
}

export function storageReadiness() {
  const env = getEnv();
  const configured = hasStorageConfig();
  return {
    configured,
    liveEnabled: env.STORAGE_LIVE_ENABLED,
    compatibilityVerified: env.STORAGE_COMPATIBILITY_VERIFIED,
    ready: isStorageReady({
      configured,
      liveEnabled: env.STORAGE_LIVE_ENABLED,
      compatibilityVerified: env.STORAGE_COMPATIBILITY_VERIFIED
    })
  };
}
