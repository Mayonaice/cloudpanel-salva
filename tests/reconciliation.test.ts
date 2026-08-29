import assert from "node:assert/strict";
import test from "node:test";
import { buildReconciliationReport, planOwnedPurgeDeletes } from "../src/lib/reconciliation";

test("bucket-root reconciliation never auto-deletes untracked objects", () => {
  const report = buildReconciliationReport({
    managed: [
      { objectKey: "a".repeat(64), status: "ready" },
      { objectKey: "b".repeat(64), status: "purge_pending" },
      { objectKey: "c".repeat(64), status: "purged" }
    ],
    provider: [
      { objectKey: "a".repeat(64), size: 1 },
      { objectKey: "legacy/other-project.bin", size: 2 },
      { objectKey: "orphan".repeat(8), size: 3 }
    ]
  });
  assert.deepEqual(report.missingManagedKeys, ["b".repeat(64)]);
  assert.deepEqual(report.untrackedProviderKeys, ["legacy/other-project.bin", "orphan".repeat(8)]);
  assert.deepEqual(report.automaticDeleteKeys, []);
  assert.deepEqual(planOwnedPurgeDeletes([
    { objectKey: "b".repeat(64), status: "purge_pending" },
    { objectKey: "legacy/other-project.bin", status: "purge_pending" }
  ]), ["b".repeat(64)]);
});

test("invalid managed keys fail closed in reconciliation evidence", () => {
  const report = buildReconciliationReport({
    managed: [{ objectKey: "not-a-provider-key", status: "ready" }],
    provider: []
  });
  assert.deepEqual(report.invalidManagedKeys, ["not-a-provider-key"]);
  assert.deepEqual(report.missingManagedKeys, ["not-a-provider-key"]);
  assert.deepEqual(report.automaticDeleteKeys, []);
});
