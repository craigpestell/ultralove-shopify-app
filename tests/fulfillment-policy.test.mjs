import assert from "node:assert/strict";
import { test } from "node:test";
import { fulfillmentMode, fulfillmentModes, fulfillmentSignature, modeFor } from "../app/fulfillment-policy.ts";
import { catalogOnlyPayload, payload, verifyDraft, VERIFY_QUERY } from "../app/import-engine.ts";

test("catalog-only defaults, exact per-product choices and immutable signatures", () => {
  assert.equal(modeFor({}, 1), "CATALOG");
  assert.deepEqual(fulfillmentModes({ 1: "CATALOG", 2: "DROPSHIPPING" }, [1, 2]), { 2: "DROPSHIPPING" });
  assert.equal(fulfillmentSignature([2, 1], {}), fulfillmentSignature([1, 2], { 1: "CATALOG" }));
  assert.notEqual(fulfillmentSignature([1, 2], {}), fulfillmentSignature([1, 2], { 2: "DROPSHIPPING" }));
  for (const value of [null, "catalog", "", false]) assert.throws(() => fulfillmentMode(value));
  for (const value of [null, [], { 3: "DROPSHIPPING" }, { 1: "wrong" }, { "01": "CATALOG" }]) {
    assert.throws(() => fulfillmentModes(value, [1, 2]));
  }
});

test("catalog-only payload excludes supplier quantities without allowing untracked or overselling stock", async () => {
  const run = "a".repeat(32);
  const location = "gid://shopify/Location/1";
  const supplier = {
    title: "Catalog item", handle: "ultralove-catalog-1", status: "DRAFT",
    tags: ["ultralove-catalog-import", `ultralove-catalog-run-${run}`],
    metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", value: "1" }],
    variants: [{
      sku: "SKU-1", price: "12.50", inventoryPolicy: "DENY", inventoryItem: { tracked: true },
      inventoryQuantities: [{ locationId: location, name: "available", quantity: 857 }],
      metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", value: "1" }],
    }],
  };
  const original = structuredClone(supplier);
  const clean = catalogOnlyPayload(payload(supplier, 1, run, location));
  assert.equal("inventoryQuantities" in clean.variants[0], false);
  assert.equal(clean.variants[0].inventoryItem.tracked, true);
  assert.equal(clean.variants[0].inventoryPolicy, "DENY");
  assert.deepEqual(supplier, original);
  assert.deepEqual(payload(clean, 1, run, location, "CATALOG"), clean);
  assert.throws(() => payload(supplier, 1, run, location, "CATALOG"), /must not contain/);
  assert.throws(() => payload(clean, 1, run, location), /supplier list/);
  assert.throws(() => payload({ ...clean, variants: [{ ...clean.variants[0], inventoryItem: { tracked: false } }] }, 1, run, location, "CATALOG"));
  assert.throws(() => payload({ ...clean, variants: [{ ...clean.variants[0], inventoryPolicy: "CONTINUE" }] }, 1, run, location, "CATALOG"));
  const response = (level) => ({ data: { product: { status: "DRAFT", variants: {
    nodes: [{ sku: "SKU-1", price: "12.50", barcode: null, supplierId: { value: "1" }, inventoryPolicy: "DENY",
      inventoryItem: { tracked: true, inventoryLevel: level } }], pageInfo: { hasNextPage: false },
  } } } });
  for (const level of [null, { quantities: [{ name: "available", quantity: 0 }] }]) {
    await verifyDraft(async (query, variables) => {
      assert.equal(query, VERIFY_QUERY);
      assert.equal(variables.location, location);
      return response(level);
    }, clean, "gid://shopify/Product/1", "DRAFT", location);
  }
  await assert.rejects(verifyDraft(async () => response({ quantities: [{ name: "available", quantity: 857 }] }),
    clean, "gid://shopify/Product/1", "DRAFT", location), /inventory verification/);
});
