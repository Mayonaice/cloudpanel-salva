import assert from "node:assert/strict";
import test from "node:test";
import { createShareToken, hashSharePassword, hashShareToken, isShareToken, shareUrlTtlSeconds, verifySharePassword } from "../src/lib/share";

test("share passwords are verifiable without storing the cleartext", async () => {
  const password = "correct horse battery staple";
  const encoded = await hashSharePassword(password);
  assert.equal(await verifySharePassword(password, encoded), true);
  assert.equal(await verifySharePassword("wrong password", encoded), false);
  assert.equal(encoded.includes(password), false);
  const longPassword = "x".repeat(80);
  const longHash = await hashSharePassword(longPassword);
  assert.equal(await verifySharePassword(longPassword, longHash), true);
  assert.equal(await verifySharePassword(`${longPassword}different`, longHash), false);
});

test("share tokens are hash-addressable and raw tokens are not their hashes", () => {
  const token = createShareToken();
  assert.equal(hashShareToken(token.raw), token.hash);
  assert.notEqual(token.raw, token.hash);
  assert.equal(token.raw.length >= 42, true);
  assert.equal(isShareToken(token.raw), true);
  assert.equal(isShareToken(`${token.raw}x`), false);
});

test("share download URLs never outlive the share", () => {
  const now = Date.parse("2026-08-28T00:00:00.000Z");
  assert.equal(shareUrlTtlSeconds(new Date(now + 60_000), now), 60);
  assert.equal(shareUrlTtlSeconds(new Date(now + 60 * 60_000), now), 300);
  assert.equal(shareUrlTtlSeconds(new Date(now - 1), now), 1);
});
