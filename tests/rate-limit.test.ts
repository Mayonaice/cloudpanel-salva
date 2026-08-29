import assert from "node:assert/strict";
import test from "node:test";
import { clearRateLimitStore, consumeRateLimit } from "../src/lib/rate-limit";

test("rate limiter enforces a bounded window and resets", () => {
  clearRateLimitStore();
  assert.equal(consumeRateLimit("test", 2, 1_000, 10_000).allowed, true);
  assert.equal(consumeRateLimit("test", 2, 1_000, 10_100).allowed, true);
  const blocked = consumeRateLimit("test", 2, 1_000, 10_200);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(consumeRateLimit("test", 2, 1_000, 11_001).allowed, true);
});
