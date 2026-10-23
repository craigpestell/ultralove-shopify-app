import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFragment, serialize } from "parse5";
import { MAX_PREVIEW_AGE, matchProduct } from "../app/import-engine.ts";
import { defaultListingPolicy } from "../app/listing-policy.ts";
import {
  applyListing, assertLinkOwnership, listedVariants, listingChanges, listingSnapshot, matchListingVariants,
  LISTING_QUERY, LISTING_UPDATE_MUTATION, LISTING_PRICES_MUTATION, LISTING_METADATA_MUTATION,
} from "../app/listing-engine.ts";
import { listingApi, retailerListing, supplierInput, runId } from "./fixtures/listing-fixture.mjs";

async function reviewed(mock, policy, action = "UPDATE", input = supplierInput) {
  const baseline = await listingSnapshot(mock.api, mock.state.product.id);
  const variantIds = matchListingVariants(baseline, input, action === "LINK");
  const state = { work: { baseline, variantIds, capturedAt: Date.now() } };
  const options = { api: mock.api, input, policy, supplierId: 100, runId,
    review: { action, targetId: baseline.id, changes: listingChanges(baseline, input, policy, variantIds), message: null },
    saveWork: async (work) => { state.work = structuredClone(work); } };
  return { state, run: () => applyListing({ ...options, work: state.work }), options };
}
test("HTML entities, optional paragraph endings, void tags and harmless list indentation are equivalent", async () => {
  const mock = listingApi();
  mock.state.product.descriptionHtml = '<p>It\'s &amp; works<br><img alt="Image" src="https://example.com/a.jpg"></p><ul>\n<li>First</li>\n<li>Second</li>\n</ul>';
  const input = { ...supplierInput, title: mock.state.product.title, vendor: mock.state.product.vendor,
    descriptionHtml: '<p>It&#039;s &amp; works<br/><img src="https://example.com/a.jpg" alt="Image"/><ul><li>First</li><li>Second</li></ul>' };
  const review = await reviewed(mock, { ...defaultListingPolicy(), mode: "UPDATE", content: true }, "UPDATE", input);
  assert.deepEqual(review.options.review.changes, []);
  assert.equal((await review.run()).status, "UPDATED");
  assert.equal(mock.state.calls.length, 0, "equivalent HTML does not trigger repeated content writes");
});

test("Shopify-normalized content is verified and uncertain completed writes reconcile without resending", async () => {
  for (const uncertain of [false, true]) {
    const mock = listingApi();
    mock.state.before = (query) => {
      if (query === LISTING_QUERY) mock.state.product.descriptionHtml =
        serialize(parseFragment(mock.state.product.descriptionHtml)).replace(/<ul><li>/g, "<ul>\n<li>");
    };
    const input = { ...supplierInput, descriptionHtml: '<p>New &#039;details&#039;<br/><ul><li>Item</li></ul>' };
    const review = await reviewed(mock, { ...defaultListingPolicy(), mode: "UPDATE", content: true }, "UPDATE", input);
    if (uncertain) {
      mock.state.failAfter = LISTING_UPDATE_MUTATION;
      await assert.rejects(review.run(), /Connection lost/);
      mock.state.failAfter = null;
    }
    assert.equal((await review.run()).status, "UPDATED");
    await review.run();
    assert.equal(mock.state.calls.length, 1);
  }
});

test("HTML comparison preserves meaningful text, formatting, URLs and significant whitespace", () => {
  const baseline = retailerListing();
  const policy = { ...defaultListingPolicy(), mode: "UPDATE", content: true };
  for (const [before, after] of [
    ["<p>First</p>", "<p>Second</p>"],
    ["<b>Same</b>", "<i>Same</i>"],
    ['<a href="https://example.com/one">Same</a>', '<a href="https://example.com/two">Same</a>'],
    ['<img src="https://example.com/one">', '<img src="https://example.com/two">'],
    ['<p style="color:red">Same</p>', '<p style="color:blue">Same</p>'],
    ["<pre>First\nSecond</pre>", "<pre>First Second</pre>"],
    ['<ul style="white-space:pre"><li>Item</li></ul>', '<ul style="white-space:pre">\n<li>Item</li></ul>'],
    ["&lt;b&gt;Same&lt;/b&gt;", "<b>Same</b>"],
    ["<span>A</span> <span>B</span>", "<span>A</span><span>B</span>"],
  ]) {
    const changes = listingChanges({ ...baseline, descriptionHtml: before },
      { ...supplierInput, title: baseline.title, vendor: baseline.vendor, descriptionHtml: after }, policy, []);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].field, "Description");
  }
});
test("selected content, prices and additive deduplicated images preserve product/variant identity and retailer fields", async () => {
  for (const field of ["content", "prices", "images"]) {
    const mock = listingApi();
    const before = structuredClone(mock.state.product);
    const policy = { ...defaultListingPolicy(), mode: "UPDATE", [field]: true };
    const review = await reviewed(mock, policy);
    assert.ok(review.options.review.changes.length);
    assert.deepEqual(await review.run(), { status: "UPDATED", productId: before.id });
    const after = mock.state.product;
    assert.equal(after.handle, before.handle); assert.equal(after.status, "ACTIVE");
    assert.deepEqual(after.tags, before.tags); assert.deepEqual(after.supplierId, before.supplierId);
    assert.equal(after.title, field === "content" ? supplierInput.title : before.title);
    assert.equal(after.descriptionHtml, field === "content" ? supplierInput.descriptionHtml : before.descriptionHtml);
    assert.equal(after.vendor, field === "content" ? supplierInput.vendor : before.vendor);
    assert.deepEqual(after.variants.map((variant) => ({ ...variant, price: before.variants[0].price })), before.variants);
    assert.equal(after.variants[0].price, field === "prices" ? "15.63" : "42.00");
    assert.deepEqual(after.media.slice(0, 1), before.media);
    assert.equal(after.media.length, field === "images" ? 2 : 1);
    assert.equal(mock.state.calls.length, 1);
    const again = await reviewed(mock, policy);
    await again.run();
    assert.equal(mock.state.calls.length, 1, "repeat reviewed refresh performs no duplicate writes/uploads");
  }
});
test("KEEP link matches exact SKUs, enrolls identities and preserves every retailer field", async () => {
  const mock = listingApi(retailerListing({ owned: false }));
  const before = structuredClone(mock.state.product);
  const review = await reviewed(mock, defaultListingPolicy(), "LINK");
  assert.deepEqual(review.options.review.changes, []);
  assert.equal((await review.run()).status, "LINKED");
  assert.equal(mock.state.product.handle, "retailer-handle");
  assert.equal(mock.state.product.title, before.title);
  assert.equal(mock.state.product.variants[0].price, "42.00");
  assert.deepEqual(mock.state.product.variants[0].selectedOptions, before.variants[0].selectedOptions);
  assert.deepEqual(mock.state.product.media, before.media);
  assert.equal(matchProduct([mock.state.product], 100).id, before.id);
  assert.equal(mock.state.calls.filter((call) => call.query === LISTING_METADATA_MUTATION).length, 2);
});
test("ambiguous SKU sets and other supplier/canonical ownership never permit linking", () => {
  const target = retailerListing({ owned: false });
  target.variants[0].sku = "";
  assert.throws(() => matchListingVariants(target, supplierInput, true), /unique SKUs/);
  target.variants[0].sku = "SKU-100";
  target.variants.push(structuredClone(target.variants[0]));
  assert.throws(() => matchListingVariants(target, supplierInput, true), /sets differ/);
  target.handle = "ultralove-catalog-101";
  assert.throws(() => assertLinkOwnership(target, 100), /collision/);
  target.handle = "retailer-handle"; target.supplierId = { value: "101" };
  assert.throws(() => assertLinkOwnership(target, 100), /collision/);
  target.supplierId = null; target.tags.push("ultralove-catalog-import");
  assert.throws(() => assertLinkOwnership(target, 100), /collision/);
});
test("stale ownership, variants, retailer fields and timestamps block mutation", async () => {
  for (const change of [
    (p) => { p.updatedAt = "2026-10-09T13:00:00Z"; },
    (p) => { p.supplierId.value = "101"; },
    (p) => { p.variants[0].id = "gid://shopify/ProductVariant/11"; },
    (p) => { p.variants[0].barcode = "EDIT"; },
    (p) => { p.title = "Merchant edit"; },
  ]) {
    const mock = listingApi();
    const review = await reviewed(mock, { ...defaultListingPolicy(), mode: "UPDATE", prices: true });
    change(mock.state.product);
    await assert.rejects(review.run());
    assert.equal(mock.state.calls.length, 0);
  }
  const mock = listingApi();
  const review = await reviewed(mock, { ...defaultListingPolicy(), mode: "UPDATE", content: true });
  review.state.work.capturedAt = Date.now() - MAX_PREVIEW_AGE - 1;
  await assert.rejects(review.run(), /expired/);
  assert.equal(mock.state.calls.length, 0);
});
test("durable partial requests reconcile content/prices/link metadata without repeated mutations", async () => {
  for (const [field, query, owned] of [
    ["content", LISTING_UPDATE_MUTATION, true], ["prices", LISTING_PRICES_MUTATION, true],
    [null, LISTING_METADATA_MUTATION, false],
  ]) {
    const mock = listingApi(retailerListing({ owned }));
    const policy = field ? { ...defaultListingPolicy(), mode: "UPDATE", [field]: true } : defaultListingPolicy();
    const review = await reviewed(mock, policy, owned ? "UPDATE" : "LINK");
    mock.state.failAfter = query;
    await assert.rejects(review.run(), /Connection lost/);
    mock.state.failAfter = null;
    await review.run();
    assert.equal(mock.state.calls.filter((call) => call.query === query).length, owned ? 1 : 2);
  }
});
test("uncertain image requests are reconciled by source marker or blocked, never blindly uploaded twice", async () => {
  for (const uncertain of ["failAfter", "failBefore"]) {
    const mock = listingApi();
    const review = await reviewed(mock, { ...defaultListingPolicy(), mode: "UPDATE", images: true });
    mock.state[uncertain] = LISTING_UPDATE_MUTATION;
    await assert.rejects(review.run(), /Connection lost/);
    mock.state[uncertain] = null;
    if (uncertain === "failAfter") await review.run();
    else await assert.rejects(review.run(), /uncertain images/);
    assert.equal(mock.state.calls.length, 1);
  }
});
test("unrelated changes after a partial operation block further requests", async () => {
  const mock = listingApi();
  const review = await reviewed(mock, { ...defaultListingPolicy(), mode: "UPDATE", content: true, prices: true });
  mock.state.failAfter = LISTING_UPDATE_MUTATION;
  await assert.rejects(review.run());
  mock.state.failAfter = null;
  mock.state.product.tags.push("new-retailer-tag");
  await assert.rejects(review.run(), /baseline changed/);
  assert.equal(mock.state.calls.length, 1);
});

test("retail refresh compares exact CAD cents beyond floating-point precision", async () => {
  const mock = listingApi();
  mock.state.product.variants[0].price = "9007199254740992.00";
  const input = structuredClone(supplierInput);
  input.variants[0].price = "9007199254740993.00";
  const baseline = await listingSnapshot(mock.api, mock.state.product.id);
  const variantIds = matchListingVariants(baseline, input, false);
  const policy = { ...defaultListingPolicy(), mode: "UPDATE", prices: true };
  const changes = listingChanges(baseline, input, policy, variantIds);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].after, input.variants[0].price);
  await applyListing({ api: mock.api, input, policy, supplierId: 100, runId,
    review: { action: "UPDATE", targetId: baseline.id, changes, message: null },
    work: { baseline, variantIds, capturedAt: Date.now() }, saveWork: async () => {} });
  assert.equal(mock.state.product.variants[0].price, input.variants[0].price);
  assert.equal(mock.state.calls.length, 1);
});

test("malformed Shopify metadata, media and variant fields fail before updates", async () => {
  for (const corrupt of [
    (p) => { p.supplierId.compareDigest = null; },
    (p) => { p.variants[0].price = "invalid"; },
    (p) => { p.variants[0].inventoryItem.id = "gid://shopify/Product/20"; },
    (p) => { p.variants[0].selectedOptions[0].value = null; },
    (p) => { p.variants[0].barcode = 123; },
    (p) => { p.media[0].image.url = null; },
  ]) {
    const mock = listingApi();
    corrupt(mock.state.product);
    await assert.rejects(listingSnapshot(mock.api, mock.state.product.id));
    assert.equal(mock.state.calls.length, 0);
  }
});

test("multi-page variant snapshots refresh 501 prices in bounded 250/250/1 batches", async () => {
  const mock = listingApi();
  const input = structuredClone(supplierInput);
  const original = mock.state.product.variants[0];
  mock.state.product.variants = Array.from({ length: 501 }, (_, index) => ({
    ...structuredClone(original), id: `gid://shopify/ProductVariant/${index + 100}`,
    sku: `SKU-${index + 100}`, inventoryItem: { ...original.inventoryItem, id: `gid://shopify/InventoryItem/${index + 100}` },
    supplierId: { value: String(index + 100), compareDigest: `digest-${index}` },
  }));
  input.variants = mock.state.product.variants.map((variant) => ({
    ...structuredClone(supplierInput.variants[0]), sku: variant.sku, price: "15.63",
    metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", value: variant.supplierId.value }],
  }));
  const baseline = await listingSnapshot(mock.api, mock.state.product.id);
  assert.equal(baseline.variants.length, 501);
  const variantIds = matchListingVariants(baseline, input, false);
  const policy = { ...defaultListingPolicy(), mode: "UPDATE", prices: true };
  await applyListing({ api: mock.api, input, policy, supplierId: 100, runId,
    review: { action: "UPDATE", targetId: baseline.id, changes: listingChanges(baseline, input, policy, variantIds), message: null },
    work: { baseline, variantIds, capturedAt: Date.now() }, saveWork: async () => {} });
  assert.deepEqual(mock.state.calls.filter((call) => call.query === LISTING_PRICES_MUTATION).map((call) => call.variables.variants.length), [250, 250, 1]);
  assert.deepEqual(mock.state.product.variants.map((variant) => variant.id), variantIds);
  assert.ok(mock.state.product.variants.every((variant) => variant.price === "15.63"));
});

test("a listing missing variants the retailer deleted matches the variants still on it", () => {
  const input = structuredClone(supplierInput);
  const variant = (id, sku) => ({ ...structuredClone(supplierInput.variants[0]), sku,
    metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", value: id }] });
  input.variants = [variant("101", "SKU-RED"), variant("102", "SKU-BLUE"), variant("103", "")];
  const listing = retailerListing();
  listing.variants = [{ ...listing.variants[0], id: "gid://shopify/ProductVariant/12", sku: "SKU-BLUE", supplierId: { value: "102", compareDigest: "d" } }];
  const listed = listedVariants(listing, input);
  assert.deepEqual(listed, { keep: [1], missing: ["SKU-RED", "supplier variant 103"] });
  const trimmed = { ...input, variants: listed.keep.map((index) => input.variants[index]) };
  assert.deepEqual(matchListingVariants(listing, trimmed, false), ["gid://shopify/ProductVariant/12"]);
  assert.equal(listedVariants(retailerListing(), supplierInput), null, "nothing missing");
  // Without supplier identities on every remaining variant there is nothing safe to match against.
  listing.variants[0].supplierId = null;
  assert.equal(listedVariants(listing, input), null);
  listing.variants[0].supplierId = { value: "999", compareDigest: "d" };
  assert.equal(listedVariants(listing, input), null);
});
test("a price update reaches the variants still on the listing and leaves deleted ones deleted", async () => {
  const deletedVariant = { ...structuredClone(supplierInput.variants[0]), sku: "SKU-GONE", price: "99.00",
    metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", value: "101" }] };
  const input = { ...supplierInput, variants: [supplierInput.variants[0], deletedVariant] };
  const mock = listingApi();
  const listed = listedVariants(mock.state.product, input);
  assert.deepEqual(listed, { keep: [0], missing: ["SKU-GONE"] });
  const review = await reviewed(mock, { ...defaultListingPolicy(), mode: "UPDATE", prices: true }, "UPDATE",
    { ...input, variants: listed.keep.map((index) => input.variants[index]) });
  assert.equal((await review.run()).status, "UPDATED");
  assert.deepEqual(mock.state.product.variants.map((variant) => [variant.sku, variant.price]), [["SKU-100", "15.63"]]);
});
