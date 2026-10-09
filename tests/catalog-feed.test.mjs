import assert from "node:assert/strict";
import { test } from "node:test";
import { productsPage, categoriesPage, validateSelection } from "../app/catalog.server.ts";

const product = {
  id: 1, parent_id: 0, name: "Supplier product", sku: "SKU-1", type: "simple",
  price: "12.50", currency: "CAD", manage_stock: true, stock_quantity: 0,
  stock_owner_id: 1, images: [],
};
const page = (products) => ({ products, next_after_id: products.length, has_more: false });

test("bounded browsing forwards only a product operation and preserves zero/unknown stock", async () => {
  const result = await productsPage({search: "SKU-1"}, async (request) => {
    assert.deepEqual(request, {operation: "products", filters: {search: "SKU-1"}});
    return page([product, {...product, id: 2, stock_quantity: null}]);
  });
  assert.equal(result.products[0].stock_quantity, 0);
  assert.equal(result.products[1].stock_quantity, null);
  assert.equal(result.products[0].price, "12.50");
});

test("unbounded, variant-only and invalid product responses fail explicitly", async () => {
  for (const products of [
    Array.from({length: 51}, () => product),
    [{...product, parent_id: 1}],
    [{...product, currency: "USD"}],
    [{...product, images: [null]}],
  ]) {
    await assert.rejects(productsPage({}, async () => page(products)));
  }
  await assert.rejects(productsPage({}, async () => ({products: [], has_more: "yes"})));
});

test("category browsing remains bounded and retains real supplier IDs", async () => {
  const result = await categoriesPage(50, async (request) => {
    assert.deepEqual(request, {operation: "categories", filters: {after_id: 50}});
    return {categories: [{id: 51, name: "Category"}], next_after_id: 51, has_more: true};
  });
  assert.equal(result.categories[0].id, 51);
  await assert.rejects(categoriesPage(0, async () => ({categories: Array(51).fill({id: 1, name: "Category"}), next_after_id: 51, has_more: false})));
});

test("catalog browsing retains the ordered supplier images for row previews", async () => {
  const images = [
    { src: "https://example.com/front.jpg", alt: "Front view" },
    { src: "https://example.com/back.jpg", alt: "Back view" },
  ];
  const result = await productsPage({}, async () => page([{ ...product, images }]));
  assert.deepEqual(result.products[0].images, images);
});

test("selection must be fully confirmed before saving; empty selection needs no feed request", async () => {
  await validateSelection([], async () => { throw new Error("Unexpected request"); });
  await validateSelection([1, 2], async () => ({ids: [2, 1]}));
  for (const ids of [[1], [1, 1], [1, "2"], [1, 2, 3]]) {
    await assert.rejects(validateSelection([1, 2], async () => ({ids})));
  }
});
