import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inventoryFeed, mappings, remoteInventory, stockOperation, stockPlan, setStock,
  INVENTORY_QUERY, INVENTORY_SET_MUTATION, InventoryMutationError, InventoryProductMissingError, verifyMappings,
} from "../app/inventory-engine.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const location = "gid://shopify/Location/1";
const productId = "gid://shopify/Product/100";
const current = [{ sourceId: 101, variantId: "gid://shopify/ProductVariant/101",
  inventoryItemId: "gid://shopify/InventoryItem/101", onHand: 4, committed: 2 }];
const stock = { id: 101, manage_stock: true, stock_quantity: 7, stock_owner_id: 101, stock_status: "instock" };
const source = { generation, cursor: 8, parent_id: 100, published: true, source_ids: [101], inventory: [stock], resynced: false };

test("inventory plans correct on-hand stock without replacing Shopify order reservations", () => {
  const feed = inventoryFeed(source, 100, null);
  const plan = stockPlan(current, feed, location);
  assert.deepEqual(plan.changed, [{ inventoryItemId: current[0].inventoryItemId, locationId: location, quantity: 7, compareQuantity: 4 }]);
  assert.deepEqual(plan.warnings, []);
  assert.equal(current[0].committed, 2);
  assert.equal(plan.desired[0].quantity - current[0].committed, 5, "available stock remains reduced by outstanding Shopify orders");
  assert.equal(stockPlan([{ ...current[0], onHand: 7 }], feed, location).changed.length, 0);
});
test("withdrawn, shared, unmanaged, unknown and out-of-stock quantities never become sellable stock", () => {
  for (const changes of [
    { manage_stock: false }, { stock_quantity: null }, { stock_owner_id: 100 },
    { stock_status: "outofstock" }, { stock_quantity: -3 },
  ]) {
    const plan = stockPlan(current, inventoryFeed({ ...source, inventory: [{ ...stock, ...changes }] }, 100, null), location);
    assert.equal(plan.desired[0].quantity, 0);
    assert.match(plan.warnings.join(" "), /reserved orders/);
  }
  const withdrawn = stockPlan(current, inventoryFeed({ ...source, published: false, source_ids: [], inventory: [] }, 100, null), location);
  assert.equal(withdrawn.desired[0].quantity, 0);
  assert.match(withdrawn.warnings.join(" "), /withdrawn/);
  const variants = stockPlan(current, inventoryFeed({ ...source, source_ids: [102], inventory: [{ ...stock, id: 102, stock_owner_id: 102 }] }, 100, null), location);
  assert.equal(variants.desired[0].quantity, 0);
  assert.match(variants.warnings.join(" "), /New supplier variants/);
  assert.match(variants.warnings.join(" "), /101 is unavailable/);
});
test("malformed stock, identities and checkpoints fail explicitly instead of implying withdrawal", () => {
  for (const change of [
    { cursor: -1 }, { parent_id: 999 }, { inventory: [{ ...stock, stock_quantity: 1.5 }] },
    { inventory: [stock, stock] }, { source_ids: [101, 101] }, { inventory: [{ ...stock, id: 999 }] },
    { published: false }, { inventory: [{ ...stock, stock_owner_id: undefined }] },
  ]) assert.throws(() => inventoryFeed({ ...source, ...change }, 100, null));
  assert.throws(() => inventoryFeed(source, 100, { generation, cursor: 9 }));
  assert.throws(() => inventoryFeed({ ...source, generation: generation.replace(/1$/, "2") }, 100, { generation, cursor: 8 }));
  assert.equal(inventoryFeed({ ...source, resynced: true }, 100, { generation, cursor: 9 }).cursor, 8);
  assert.throws(() => mappings([...current, current[0]]));
  assert.throws(() => verifyMappings(mappings(current), [{ ...current[0], inventoryItemId: "gid://shopify/InventoryItem/999" }]));
});
test("stock mutations use persisted idempotency and compare-and-set with a maximum of 250 quantities", async () => {
  const key = "a".repeat(32);
  const input = { name: "on_hand", reason: "correction", referenceDocumentUri: `gid://ultralove/InventorySync/${key}`,
    quantities: stockPlan(current, inventoryFeed(source, 100, null), location).changed };
  await setStock(async (query, variables) => {
    assert.equal(query, INVENTORY_SET_MUTATION);
    assert.deepEqual(variables, { input: { ...input, quantities: input.quantities.map(({ compareQuantity, ...quantity }) => ({
      ...quantity, changeFromQuantity: compareQuantity,
    })) }, key });
    assert.ok(!("ignoreCompareQuantity" in variables.input));
    assert.ok(variables.input.quantities.every((quantity) => !("compareQuantity" in quantity)));
    return { data: { inventorySetQuantities: { inventoryAdjustmentGroup: { referenceDocumentUri: input.referenceDocumentUri }, userErrors: [] } } };
  }, input, key);
  await assert.rejects(setStock(async () => ({ data: { inventorySetQuantities: {
    inventoryAdjustmentGroup: null, userErrors: [{ message: "Quantity changed concurrently" }],
  } } }), input, key), InventoryMutationError);
  await assert.rejects(setStock(async () => ({ errors: [{ message: "Missing inventory permission" }] }), input, key), /permission/);
  assert.throws(() => stockOperation({ ...input, quantities: Array(251).fill(input.quantities[0]) }));
  assert.throws(() => stockOperation({ ...input, name: "available" }));
});
test("Shopify mapping discovery guards ownership, tracking and all variant pages", async () => {
  const remote = {
    id: productId, handle: "ultralove-catalog-100", tags: ["ultralove-catalog-import", `ultralove-catalog-run-${"a".repeat(32)}`],
    supplierId: { value: "100" }, variants: { nodes: [{
      id: current[0].variantId, supplierId: { value: "101" }, inventoryItem: {
        id: current[0].inventoryItemId, tracked: true, inventoryLevel: { quantities: [
          { name: "on_hand", quantity: 4 }, { name: "committed", quantity: 2 },
        ] },
      },
    }], pageInfo: { hasNextPage: false, endCursor: null } },
  };
  const api = async (query, variables) => {
    assert.equal(query, INVENTORY_QUERY);
    assert.deepEqual(variables, { id: productId, location, after: null });
    return { data: { product: remote } };
  };
  assert.deepEqual(await remoteInventory(api, productId, 100, location), current);
  await assert.rejects(remoteInventory(async () => ({ data: { product: null } }), productId, 100, location),
    (error) => error instanceof InventoryProductMissingError && /fresh import review/.test(error.message));
  for (const response of [{ data: {} }, { data: { product: undefined } },
    { errors: [{ message: "Access denied" }], data: { product: null } }]) {
    await assert.rejects(remoteInventory(async () => response, productId, 100, location),
      (error) => !(error instanceof InventoryProductMissingError),
      "malformed responses and access errors must not be treated as a missing product");
  }
  for (const field of ["handle", "tags", "supplierId", "id"]) {
    const changed = { ...remote, [field]: field === "tags" ? [] : null };
    await assert.rejects(remoteInventory(async () => ({ data: { product: changed } }), productId, 100, location));
  }
  const untracked = structuredClone(remote);
  untracked.variants.nodes[0].inventoryItem.tracked = false;
  await assert.rejects(remoteInventory(async () => ({ data: { product: untracked } }), productId, 100, location), /tracking/);
  const paged = structuredClone(remote);
  paged.variants.pageInfo = { hasNextPage: true, endCursor: "same" };
  await assert.rejects(remoteInventory(async () => ({ data: { product: paged } }), productId, 100, location), /pagination/);
});
