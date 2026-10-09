import assert from "node:assert/strict";
import { test } from "node:test";
import { CREATE_MUTATION, CONTEXT_QUERY, VERIFY_QUERY, importDraft, markupPercent, matchProduct, payload, plannedFeed, priceRange, remoteCatalog, shopContext } from "../app/import-engine.ts";

const run = "a".repeat(32);
const location = "gid://shopify/Location/1";
const input = {
  title: "Feed product", handle: "ultralove-catalog-100", status: "DRAFT",
  tags: ["ultralove-catalog-import", `ultralove-catalog-run-${run}`],
  metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", type: "single_line_text_field", value: "100" }],
  variants: [{
    sku: "TEST-100", price: "15.63", inventoryPolicy: "DENY",
    inventoryItem: { tracked: true, requiresShipping: true },
    inventoryQuantities: [{ locationId: location, name: "available", quantity: 0 }],
    metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", type: "single_line_text_field", value: "100" }],
  }],
};
const product = {
  id: "gid://shopify/Product/1", handle: input.handle, status: "DRAFT", tags: input.tags,
  supplierId: { value: "100" }, variants: { nodes: [{ sku: "TEST-100", price: "15.63" }] },
};
const verify = {
  data: { product: { status: "DRAFT", variants: {
    nodes: [{ sku: "TEST-100", price: "15.63", barcode: null, inventoryPolicy: "DENY", supplierId: { value: "100" },
      inventoryItem: { tracked: true, inventoryLevel: { quantities: [{ name: "available", quantity: 0 }] } } }],
    pageInfo: { hasNextPage: false, endCursor: null },
  } } },
};
const base = {
  products: [], input, supplierId: 100, runId: run, attempted: false, previouslyMapped: false,
  fresh: true, beforeMutation: async () => {},
};
test("markup bounds and monetary preview retain zero, missing and fractional supplier prices", () => {
  for (const [value, expected] of [["0", "0.00"], ["25", "25.00"], ["1000.00", "1000.00"], ["0.01", "0.01"]]) assert.equal(markupPercent(value), expected);
  for (const value of ["", "-1", "1000.01", "1e2", "25.001", "NaN", null, "01"]) assert.throws(() => markupPercent(value));
  assert.equal(priceRange(["12.50", "2.25", "0.00"]), "0.00 - 12.50 CAD");
  assert.equal(priceRange(["0.005"]), "0.005 CAD");
  assert.equal(priceRange([null]), "Missing price - review required");
  assert.match(priceRange([null, "1.00"]), /some missing/);
});
test("payload rejects publication, updates, changed locations, invented quantities and identity loss", () => {
  assert.equal(payload(input, 100, run, location).variants[0].inventoryQuantities[0].quantity, 0);
  for (const changed of [
    { ...input, status: "ACTIVE" }, { ...input, id: product.id }, { ...input, metafields: [] },
    { ...input, variants: [{ ...input.variants[0], id: "gid://shopify/ProductVariant/1" }] },
    { ...input, variants: [{ ...input.variants[0], inventoryQuantities: [{ locationId: location, name: "available", quantity: -1 }] }] },
  ]) assert.throws(() => payload(changed, 100, run, location));
  assert.throws(() => payload(input, 100, run, "gid://shopify/Location/2"));
});
test("plan requires every selected parent and complete variant pricing", () => {
  const feed = { generation: "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12), cursor: 1,
    items: [{ supplierId: 100, name: "Feed product", sku: "TEST-100", wholesale: ["12.50"], payload: input }] };
  assert.equal(plannedFeed(feed, [100], run, location).items.length, 1);
  assert.throws(() => plannedFeed(feed, [100, 101], run, location));
  assert.throws(() => plannedFeed({ ...feed, items: [...feed.items, ...feed.items] }, [100], run, location));
  assert.throws(() => plannedFeed(feed, Array.from({ length: 51 }, (_, index) => index + 1), run, location));
  const ids = Array.from({ length: 50 }, (_, index) => index + 1);
  const fifty = { ...feed, items: ids.map((id) => {
    const copy = structuredClone(feed.items[0]);
    copy.supplierId = id;
    copy.payload.handle = `ultralove-catalog-${id}`;
    copy.payload.metafields[0].value = String(id);
    copy.payload.variants[0].metafields[0].value = String(id);
    return copy;
  }) };
  assert.equal(plannedFeed(fifty, ids, run, location).items.length, 50);
});
test("CAD and exact merchant location must be confirmed", async () => {
  const context = { data: { shop: { myshopifyDomain: "lab.myshopify.com", currencyCode: "CAD" },
    locations: { nodes: [{ id: location, name: "Shop location", isActive: true, fulfillsOnlineOrders: true }], pageInfo: { hasNextPage: false } } } };
  assert.equal(await shopContext(async (query) => { assert.equal(query, CONTEXT_QUERY); return context; }, "lab.myshopify.com"), location);
  await assert.rejects(shopContext(async () => context, "foreign.myshopify.com"));
  await assert.rejects(shopContext(async () => ({ data: { ...context.data, shop: { ...context.data.shop, currencyCode: "USD" } } }), "lab.myshopify.com"));
});
test("only canonical owned listings are reused without mutations; old test listings are ignored", async () => {
  const existing = { ...product, tags: ["ultralove-catalog-import", `ultralove-catalog-run-${"b".repeat(32)}`], status: "ACTIVE" };
  const baseline = structuredClone(existing);
  const result = await importDraft({ ...base, products: [existing], api: async () => { throw new Error("No request allowed for reused products"); } });
  assert.deepEqual(result, { status: "REUSED", productId: product.id });
  assert.deepEqual(existing, baseline);
  const legacy = { ...product, handle: "ultralove-dev-1513", tags: ["ultralove-dev-supplier"], supplierId: null, variants: { nodes: [{ sku: "1513", price: "99.00" }] } };
  assert.equal(matchProduct([legacy], 17186), null);
  assert.equal(matchProduct([], 17186), null, "old fixture IDs no longer require legacy listings");
  const canonical = { ...product, handle: "ultralove-catalog-17186", supplierId: { value: "17186" } };
  assert.equal(matchProduct([legacy, canonical], 17186).id, product.id);
});
test("unowned collisions and duplicate identities fail before mutation", async () => {
  assert.throws(() => matchProduct([{ ...product, tags: [] }], 100));
  assert.throws(() => matchProduct([product, { ...product, id: "gid://shopify/Product/2" }], 100));
  await assert.rejects(importDraft({ ...base, products: [{ ...product, tags: [] }], api: async () => { throw new Error("Must not mutate"); } }));
  await assert.rejects(importDraft({ ...base, expectedProductId: "gid://shopify/Product/2", products: [product],
    api: async () => { throw new Error("Must not mutate replaced mappings"); } }), /mapping was replaced/);
});
test("fresh import persists a claim before one mutation and verifies exact draft output", async () => {
  const calls = [];
  const result = await importDraft({ ...base, products: [], beforeMutation: async () => { calls.push("claim"); },
    api: async (query, variables) => {
      if (query === CREATE_MUTATION) {
        assert.deepEqual(calls, ["claim"]);
        assert.equal(variables.input.status, "DRAFT");
        assert.equal("id" in variables.input, false);
        calls.push("create");
        return { data: { productSet: { product, userErrors: [] } } };
      }
      assert.equal(query, VERIFY_QUERY);
      calls.push("verify");
      return verify;
    },
  });
  assert.deepEqual(result, { status: "CREATED", productId: product.id });
  assert.deepEqual(calls, ["claim", "create", "verify"]);
});
test("uncertain creation, removed mappings and expired previews never authorize another creation", async () => {
  for (const changed of [{ attempted: true }, { previouslyMapped: true }, { fresh: false }]) {
    await assert.rejects(importDraft({ ...base, ...changed, api: async () => { throw new Error("No mutation allowed"); } }));
  }
  let calls = 0;
  await assert.rejects(importDraft({ ...base, api: async () => { calls++; throw new Error("Connection lost after sending"); } }));
  await assert.rejects(importDraft({ ...base, attempted: true, api: async () => { calls++; return {}; } }));
  assert.equal(calls, 1);
});
test("recovered own-run draft is verified read-only; partial variants and wrong price fail", async () => {
  const result = await importDraft({ ...base, attempted: true, products: [product], api: async (query) => { assert.equal(query, VERIFY_QUERY); return verify; } });
  assert.equal(result.status, "CREATED");
  for (const changed of [
    { ...verify.data.product, status: "ACTIVE" },
    { ...verify.data.product, variants: { nodes: [], pageInfo: { hasNextPage: false } } },
    { ...verify.data.product, variants: { ...verify.data.product.variants, nodes: [{ ...verify.data.product.variants.nodes[0], price: "99.99" }] } },
  ]) await assert.rejects(importDraft({ ...base, products: [product], api: async () => ({ data: { product: changed } }) }));
});
test("Shopify pagination advances and repeated cursors fail explicitly", async () => {
  let calls = 0;
  const api = async () => ({ data: { products: { nodes: [product], pageInfo: { hasNextPage: ++calls < 2, endCursor: "cursor" } } } });
  assert.equal((await remoteCatalog(api)).length, 2);
  await assert.rejects(remoteCatalog(async () => ({ data: { products: { nodes: [product], pageInfo: { hasNextPage: true, endCursor: "cursor" } } } })));
});

test("nullable Shopify SKUs on unrelated listings and review-only drafts remain valid", async () => {
  const nullable = { ...product, variants: { nodes: [{ sku: null, price: "15.63" }] } };
  const catalog = await remoteCatalog(async () => ({ data: { products: { nodes: [nullable], pageInfo: { hasNextPage: false } } } }));
  assert.equal(catalog[0].variants.nodes[0].sku, "");
  const missingSku = { ...input, variants: [{ ...input.variants[0], sku: "" }] };
  const checked = { ...verify.data.product, variants: { ...verify.data.product.variants,
    nodes: [{ ...verify.data.product.variants.nodes[0], sku: null }] } };
  const result = await importDraft({ ...base, input: missingSku, products: [], api: async (query) => query === CREATE_MUTATION
    ? { data: { productSet: { product: nullable, userErrors: [] } } }
    : { data: { product: checked } } });
  assert.equal(result.status, "CREATED");
});
