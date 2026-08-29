import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { rateLimits } from "./db/schema";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Process-local fallback for development and smoke tests. Production should
 * replace this store with a shared limiter so instance rotation cannot bypass
 * the password-attempt boundary.
 */
export function consumeRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new RangeError("Rate-limit bounds must be positive integers");
  }
  if (buckets.size >= MAX_BUCKETS && !buckets.has(key)) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest) buckets.delete(oldest);
    }
  }
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    const next = { count: 1, resetAt: now + windowMs };
    buckets.set(key, next);
    return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }

  if (current.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }

  current.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, limit - current.count),
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  };
}

export function requestClientKey(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip") || "unknown-client";
  return createHash("sha256").update(address, "utf8").digest("hex").slice(0, 24);
}

/** Shared, atomic limiter for serverless instances. Fail closed on DB errors. */
export async function consumeSharedRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateLimitResult> {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError("Invalid rate-limit bounds");
  const nowIso = new Date(now).toISOString();
  const resetAt = new Date(now + windowMs);
  const [bucket] = await getDb().insert(rateLimits).values({ key: createHash("sha256").update(key).digest("hex"), count: 1, resetAt })
    .onConflictDoUpdate({ target: rateLimits.key, set: {
      count: sql`CASE WHEN ${rateLimits.resetAt} <= ${nowIso}::timestamptz THEN 1 ELSE LEAST(${rateLimits.count} + 1, ${limit + 1}) END`,
      resetAt: sql`CASE WHEN ${rateLimits.resetAt} <= ${nowIso}::timestamptz THEN ${resetAt.toISOString()}::timestamptz ELSE ${rateLimits.resetAt} END`
    } }).returning();
  return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt.getTime() - now) / 1000)) };
}

export function clearRateLimitStore() {
  buckets.clear();
}
