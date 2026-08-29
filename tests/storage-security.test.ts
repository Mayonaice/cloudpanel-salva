import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { encryptCredentials, decryptCredentials } from "../src/lib/credential-vault";
import { isPublicAddress, validateEndpoint } from "../src/lib/endpoint-security";

test("storage credentials are randomized and bound to the connection ID", () => {
  process.env.STORAGE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const data = { token: "fixture-only-secret" };
  const encrypted = encryptCredentials(data, "connection-a");
  assert.notEqual(encrypted, encryptCredentials(data, "connection-a"));
  assert.ok(!encrypted.includes(data.token));
  assert.deepEqual(decryptCredentials(encrypted, "connection-a"), data);
  assert.throws(() => decryptCredentials(encrypted, "connection-b"));
  const parts = encrypted.split("."); parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptCredentials(parts.join("."), "connection-a"));
});
test("endpoint validation rejects internal and ambiguous targets", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("1.1.1.1"), true);
  for (const endpoint of ["http://example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://user:pass@example.com", "https://example.com/path", "https://example.com:8080", "https://example.com?x=1"]) assert.throws(() => validateEndpoint(endpoint), endpoint);
  assert.equal(validateEndpoint("https://nas.example.com/"), "https://nas.example.com");
});
