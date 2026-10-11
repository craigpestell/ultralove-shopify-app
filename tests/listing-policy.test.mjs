import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultListingPolicy, listingPolicy, listingSignature, ListingPolicyError } from "../app/listing-policy.ts";

test("listing policy defaults keep everything and strictly bounds approved links/replacements", () => {
  const defaults = defaultListingPolicy();
  assert.deepEqual(listingPolicy(undefined, [100]), defaults);
  assert.deepEqual(listingPolicy({ ...defaults, content: true }, [100]), { ...defaults, content: true },
    "KEEP retains UI choices, but the engine ignores them");
  for (const invalid of [null, {}, { ...defaults, mode: "UPDATE" }, { ...defaults, mode: { toString: () => "KEEP" } },
    { ...defaults, content: "true" }, { ...defaults, links: { 101: "gid://shopify/Product/1" } },
    { ...defaults, links: { 100: "1" } }, { ...defaults, recreate: [101] }, { ...defaults, recreate: [100, 100] },
    { ...defaults, links: { 100: "gid://shopify/Product/1" }, recreate: [100] },
    { ...defaults, extra: true }]) {
    assert.throws(() => listingPolicy(invalid, [100]), ListingPolicyError);
  }
  assert.throws(() => listingPolicy({ ...defaults, links: { 100: "gid://shopify/Product/1", 101: "gid://shopify/Product/1" } }, [100, 101]));
  assert.equal(listingSignature({ ...defaults, mode: "UPDATE" }), '{"mode":"UPDATE","content":false,"images":false,"prices":false,"links":{},"recreate":[]}');
  assert.equal(listingSignature({ ...defaults, links: { 102: "gid://shopify/Product/2", 100: "gid://shopify/Product/1" }, recreate: [104, 103] }),
    listingSignature({ ...defaults, links: { 100: "gid://shopify/Product/1", 102: "gid://shopify/Product/2" }, recreate: [103, 104] }));
});
