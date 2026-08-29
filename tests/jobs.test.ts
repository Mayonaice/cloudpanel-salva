import assert from "node:assert/strict";
import test from "node:test";
import { boundedLeaseSeconds, retryDelayMs } from "../src/lib/job-policy";
import { isJobKind } from "../src/lib/jobs";

test("job leases and backoff stay bounded for serverless invocations", () => {
  assert.equal(boundedLeaseSeconds(undefined), 60);
  assert.equal(boundedLeaseSeconds(9999), 300);
  assert.equal(boundedLeaseSeconds(0), 1);
  assert.equal(retryDelayMs(1), 1_000);
  assert.equal(retryDelayMs(99), 15 * 60 * 1_000);
});

test("only known bounded job kinds are accepted", () => {
  assert.equal(isJobKind("cleanup_multipart"), true);
  assert.equal(isJobKind("purge_file"), true);
  assert.equal(isJobKind("run_arbitrary_sql"), false);
});
