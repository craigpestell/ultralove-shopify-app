import assert from "node:assert/strict";
import { test } from "node:test";
import { importStatus } from "../app/storefront-status.ts";

const now = new Date("2026-10-22T06:00:00Z");
const item = (supplierId, status, variants, error = null) => ({ supplierId, name: `Product ${supplierId}`, sku: `SKU-${supplierId}`, status, error, variants });

test("latest import counts products and variants by outcome and lists failures", () => {
  const status = importStatus({ now, names: new Map([[300, "Ring"]]), claims: [], syncs: [], jobs: [
    { id: "b", status: "FAILED", error: "1 product(s) require review.", createdAt: new Date("2026-10-22T05:00:00Z"),
      updatedAt: new Date("2026-10-22T05:10:00Z"),
      items: [item(1, "CREATED", 3), item(2, "REUSED", 1), item(3, "UPDATED", 2), item(4, "LINKED", 1), item(5, "FAILED", 4, "Unsafe import variant."), item(6, "PENDING", 2)] },
    { id: "a", status: "COMPLETE", error: null, createdAt: new Date("2026-10-21T05:00:00Z"), updatedAt: new Date("2026-10-21T05:01:00Z"),
      items: [item(1, "CREATED", 3)] },
  ] });
  assert.equal(status.generatedAt, now.toISOString());
  assert.deepEqual(status.latest.products, { total: 6, created: 2, updated: 2, failed: 1, pending: 1 });
  assert.deepEqual(status.latest.variants, { total: 13, created: 4, updated: 3, failed: 4, pending: 2 });
  assert.equal(status.latest.finishedAt, "2026-10-22T05:10:00.000Z");
  assert.deepEqual(status.latest.issues, [{ supplierId: 5, name: "Product 5", sku: "SKU-5", error: "Unsafe import variant." }]);
  assert.equal(status.history.length, 2);
  assert.deepEqual(status.history[1], { id: "a", status: "COMPLETE", startedAt: "2026-10-21T05:00:00.000Z", total: 1, created: 1, updated: 0, failed: 0, pending: 0 });
});

test("a running import has no finish time and an empty store has no latest import", () => {
  const running = importStatus({ now, names: new Map(), claims: [], syncs: [], jobs: [
    { id: "c", status: "RUNNING", error: null, createdAt: now, updatedAt: now, items: [item(1, "RUNNING", 1)] }] });
  assert.equal(running.latest.finishedAt, null);
  assert.equal(running.latest.products.pending, 1);
  assert.equal(importStatus({ now, names: new Map(), claims: [], syncs: [], jobs: [] }).latest, null);
});

test("inventory summary covers current listings only and reports failed syncs", () => {
  const sync = (supplierId, enabled, status, lastSuccessAt, nextRunAt, error = null) =>
    ({ supplierId, enabled, status, error, lastSuccessAt: lastSuccessAt && new Date(lastSuccessAt), nextRunAt: new Date(nextRunAt) });
  const status = importStatus({ now, jobs: [], names: new Map([[2, "Bracelet"]]),
    claims: [{ supplierId: 1, deletedAt: null }, { supplierId: 2, deletedAt: null }, { supplierId: 3, deletedAt: null },
      { supplierId: 4, deletedAt: null }, { supplierId: 5, deletedAt: now }],
    syncs: [sync(1, true, "SYNCED", "2026-10-22T05:50:00Z", "2026-10-22T06:05:00Z"),
      sync(2, true, "FAILED", "2026-10-22T05:40:00Z", "2026-10-22T06:02:00Z", "Supplier feed unavailable."),
      sync(3, false, "PAUSED", null, "2026-10-22T05:00:00Z"),
      sync(5, true, "REVIEW", null, "2026-10-22T05:00:00Z")] });
  assert.deepEqual(status.inventory, {
    listed: 4, enrolled: 2, paused: 1, notEnrolled: 1, states: { SYNCED: 1, FAILED: 1 },
    lastSuccessAt: "2026-10-22T05:50:00.000Z", nextRunAt: "2026-10-22T06:02:00.000Z",
    issues: [{ supplierId: 2, name: "Bracelet", error: "Supplier feed unavailable." }], issueCount: 1,
  });
});
