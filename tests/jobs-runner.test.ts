import assert from "node:assert/strict";
import test from "node:test";
import { boundedBatchSize, boundedLeaseSeconds, retryDelayMs } from "../src/lib/job-policy";
import { bearerToken, isCronAuthorized, parseJobRunOptions, PermanentJobError, processClaimedJob } from "../src/lib/jobs-runner";

test("jobs runner authorization accepts only a bearer secret", () => {
  const request = new Request("http://localhost/api/internal/jobs/run", { headers: { authorization: "Bearer cron-secret" } });
  assert.equal(bearerToken("Bearer cron-secret"), "cron-secret");
  assert.equal(isCronAuthorized(request, "cron-secret"), true);
  assert.equal(isCronAuthorized(request, "wrong-secret"), false);
  assert.equal(isCronAuthorized(new Request(request), undefined), false);
  assert.equal(bearerToken("Basic cron-secret"), null);
  assert.equal(bearerToken("Bearer two words"), null);
});

test("jobs runner options clamp batch, lease, and retry bounds", () => {
  const options = parseJobRunOptions(new Request("http://localhost/api/internal/jobs/run?batch=999&leaseSeconds=9999"));
  assert.equal(options.batchSize, 25);
  assert.equal(options.leaseSeconds, 300);
  assert.equal(boundedBatchSize(0), 1);
  assert.equal(boundedBatchSize(undefined), 10);
  assert.equal(boundedLeaseSeconds(-2), 1);
  assert.equal(retryDelayMs(99), 15 * 60 * 1_000);
});

test("malformed known job payloads are permanent failures", async () => {
  const validOwnerId = "00000000-0000-4000-8000-000000000000";
  const cases = [
    ["purge_file", { ownerId: validOwnerId, fileId: "not-a-uuid" }],
    ["cleanup_multipart", { ownerId: validOwnerId }],
    ["reconcile_usage", { ownerId: "not-a-uuid" }]
  ] as const;
  for (const [kind, payload] of cases) {
    await assert.rejects(
      () => processClaimedJob({ kind, payload } as Parameters<typeof processClaimedJob>[0]),
      PermanentJobError
    );
  }
});
