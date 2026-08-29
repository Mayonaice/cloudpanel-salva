import assert from "node:assert/strict";
import test from "node:test";
import { createShareToken, hashShareToken } from "../src/lib/share";
import { createOpaqueObjectKey } from "../src/lib/storage";
import { canTransition, canTransitionFile, canTransitionJob, canTransitionShare, isSafeObjectKey, transition } from "../src/lib/state";

test("object keys are opaque, root-safe, and non-repeatable", () => {
  const first = createOpaqueObjectKey();
  const second = createOpaqueObjectKey();
  assert.equal(first.includes("/"), false);
  assert.equal(first.length, 64);
  assert.notEqual(first, second);
  assert.equal(isSafeObjectKey(first), true);
  assert.equal(isSafeObjectKey("folder/../secret"), false);
});

test("upload state machine rejects terminal resurrection", () => {
  assert.equal(canTransition("initiated", "uploading"), true);
  assert.equal(canTransition("completed", "uploading"), false);
  assert.throws(() => transition("completed", "uploading"), /Invalid upload transition/);
  assert.equal(transition("uploading", "completing"), "completing");
});

test("file, share, and job lifecycles do not resurrect terminal state", () => {
  assert.equal(canTransitionFile("ready", "trashed"), true);
  assert.equal(canTransitionFile("purged", "ready"), false);
  assert.equal(canTransitionShare("active", "revoked"), true);
  assert.equal(canTransitionShare("revoked", "active"), false);
  assert.equal(canTransitionJob("leased", "failed"), true);
  assert.equal(canTransitionJob("dead", "queued"), false);
  assert.equal(canTransitionJob("unknown", "queued"), false);
});

test("share tokens are high entropy and hash-only", () => {
  const token = createShareToken();
  assert.equal(token.raw.length >= 42, true);
  assert.equal(token.hash, hashShareToken(token.raw));
  assert.notEqual(token.raw, token.hash);
});
