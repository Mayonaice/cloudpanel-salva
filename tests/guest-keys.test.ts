import test from "node:test";
import assert from "node:assert/strict";
import { generateGuestKey, hashGuestKey, GUEST_KEY_PREFIX } from "../src/lib/guest-keys";
test("guest keys are long, unique, and stored only through a fixed hash", () => { const first=generateGuestKey(),second=generateGuestKey(); assert.ok(first.startsWith(GUEST_KEY_PREFIX)); assert.ok(first.length>=70); assert.notEqual(first,second); assert.match(hashGuestKey(first),/^[a-f0-9]{64}$/); assert.notEqual(hashGuestKey(first),first); assert.equal(hashGuestKey(first),hashGuestKey(first)); });
