import { getEnv, isGoogleAuthConfigured } from "@/lib/env";
import { jsonResponse } from "@/lib/security";

export const runtime = "nodejs";

export async function GET() {
  const env = getEnv();
  return jsonResponse({
    ok: true,
    service: "cloud-salvaweb",
    storageMode: "per-user-connections",
    credentialsEncryptionConfigured: Boolean(process.env.STORAGE_ENCRYPTION_KEY),
    publicRegistrationEnabled: env.PUBLIC_REGISTRATION_ENABLED,
    databaseConfigured: Boolean(env.DATABASE_URL),
    authConfigured: isGoogleAuthConfigured(),
    environment: process.env.NODE_ENV
  });
}
