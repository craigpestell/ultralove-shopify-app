import assert from "node:assert/strict";
import {
  LISTING_QUERY, LISTING_UPDATE_MUTATION, LISTING_PRICES_MUTATION, LISTING_METADATA_MUTATION, LISTING_TAGS_MUTATION,
} from "../../app/listing-engine.ts";

export const runId = "f".repeat(32);
export const location = "gid://shopify/Location/1";
export const supplierInput = {
  title: "Supplier title", descriptionHtml: "<p>Supplier details</p>", vendor: "Supplier vendor",
  handle: "ultralove-catalog-100", status: "DRAFT",
  tags: ["ultralove-catalog-import", `ultralove-catalog-run-${runId}`],
  metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", value: "100" }],
  files: [{ originalSource: "https://supplier.example/image.jpg" }, { originalSource: "https://supplier.example/image.jpg" }],
  variants: [{ sku: "SKU-100", price: "15.63", inventoryPolicy: "DENY", inventoryItem: { tracked: true },
    inventoryQuantities: [{ locationId: location, name: "available", quantity: 0 }],
    metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", value: "100" }] }],
};
export function retailerListing({ owned = true, id = "gid://shopify/Product/1" } = {}) {
  return {
    id, title: "Retailer title", descriptionHtml: "<p>Retailer details</p>", vendor: "Retailer vendor",
    handle: owned ? "ultralove-catalog-100" : "retailer-handle", status: "ACTIVE",
    tags: owned ? ["retailer-tag", "ultralove-catalog-import", `ultralove-catalog-run-${"a".repeat(32)}`] : ["retailer-tag"],
    updatedAt: "2026-10-09T12:00:00Z",
    supplierId: owned ? { value: "100", compareDigest: "product-digest" } : null,
    variants: [{ id: "gid://shopify/ProductVariant/10", sku: "SKU-100", price: "42.00", compareAtPrice: "49.00", barcode: "ABC",
      inventoryPolicy: "CONTINUE", selectedOptions: [{ name: "Size", value: "Large" }],
      inventoryItem: { id: "gid://shopify/InventoryItem/20", tracked: true },
      supplierId: owned ? { value: "100", compareDigest: "variant-digest" } : null }],
    media: [{ id: "gid://shopify/MediaImage/1", alt: "Retailer image", status: "READY", image: { url: "https://retailer.example/image.jpg" } }],
  };
}
export function listingApi(initial = retailerListing()) {
  const state = { product: structuredClone(initial), calls: [], failAfter: null, failBefore: null, before: null };
  const api = async (query, variables) => {
    await state.before?.(query, variables);
    if (query === LISTING_QUERY) {
      const product = state.product?.id === variables.id ? structuredClone(state.product) : null;
      if (product) {
        const offset = variables.after ? Number(variables.after.split("-").at(-1)) : 0;
        const hasNextPage = offset + 100 < product.variants.length;
        product.variants = { nodes: product.variants.slice(offset, offset + 100),
          pageInfo: { hasNextPage, endCursor: hasNextPage ? `variants-${offset + 100}` : null } };
        product.media = { nodes: product.media, pageInfo: { hasNextPage: false } };
      }
      return { data: { product } };
    }
    state.calls.push({ query, variables: structuredClone(variables) });
    if (state.failBefore === query) throw new Error("Connection lost before mutation");
    let key;
    if (query === LISTING_UPDATE_MUTATION) {
      key = "productUpdate";
      assert.deepEqual(Object.keys(variables.product).filter((name) => !["id", "title", "descriptionHtml", "vendor"].includes(name)), []);
      Object.assign(state.product, variables.product);
      for (const media of variables.media || []) state.product.media.push({
        id: `gid://shopify/MediaImage/${state.product.media.length + 1}`, alt: media.alt, status: "READY", image: { url: media.originalSource },
      });
    } else if (query === LISTING_PRICES_MUTATION) {
      key = "productVariantsBulkUpdate";
      assert.ok(variables.variants.length <= 250, "Shopify mutation input arrays remain bounded");
      for (const variant of variables.variants) {
        assert.deepEqual(Object.keys(variant).sort(), ["id", "price"]);
        Object.assign(state.product.variants.find((value) => value.id === variant.id), variant);
      }
    } else if (query === LISTING_METADATA_MUTATION) {
      key = "metafieldsSet";
      for (const field of variables.metafields) {
        assert.equal(field.compareDigest, null);
        const owner = field.ownerId === state.product.id ? state.product : state.product.variants.find((variant) => variant.id === field.ownerId);
        assert.equal(owner.supplierId, null);
        owner.supplierId = { value: field.value, compareDigest: `new-${field.ownerId}` };
      }
    } else {
      assert.equal(query, LISTING_TAGS_MUTATION);
      key = "tagsAdd";
      state.product.tags = [...new Set([...state.product.tags, ...variables.tags])];
    }
    state.product.updatedAt = new Date().toISOString();
    if (state.failAfter === query) throw new Error("Connection lost after mutation");
    return { data: { [key]: { userErrors: [] } } };
  };
  return { api, state };
}
