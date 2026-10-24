import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { allCategories, CatalogError, importPlan, inventoryState, inventoryStates, productsPage, categoriesPage, selectedProducts, validateSelection } from "../app/catalog.server.ts";

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

test("catalog browsing lists the cleaned name when the feed has one, else the name", async () => {
  const result = await productsPage({}, async () => page([
    { ...product, name: "SKU-1 Supplier product", clean_name: "Supplier product" },
    { ...product, id: 2, name: "SKU-2 Other", clean_name: "  " },
    { ...product, id: 3, name: "SKU-3 Third" },
  ]));
  assert.deepEqual(result.products.map((p) => p.name), ["Supplier product", "SKU-2 Other", "SKU-3 Third"]);
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

test("wholesale-only products (testers, displays) are left out of catalog pages and counted", async () => {
  const result = await productsPage({}, async () => ({ ...page([product, { ...product, id: 2, wholesale_only: true },
    { ...product, id: 3, wholesale_only: false }]), next_after_id: 3, has_more: true }));
  assert.deepEqual(result.products.map((item) => item.id), [1, 3]);
  assert.equal(result.hidden, 1);
  assert.equal(result.next_after_id, 3, "paging continues after hidden products");
  const flaggedOnly = await productsPage({}, async () => page([{ ...product, wholesale_only: true }]));
  assert.deepEqual([flaggedOnly.products, flaggedOnly.hidden], [[], 1]);
  assert.equal((await productsPage({}, async () => page([product]))).hidden, 0, "feeds before 1.3 hide nothing");
  for (const wholesale_only of [null, "yes", 1]) {
    await assert.rejects(productsPage({}, async () => page([{ ...product, wholesale_only }])), CatalogError);
  }
});

test("selections with wholesale-only products cannot be saved, and summaries mark them", async () => {
  const summaries = [{ id: 1, name: "T-1 Tester", sku: "T-1", price: "0", type: "simple", wholesale_only: true },
    { id: 2, name: "SKU-2 Product", sku: "SKU-2", price: "12.50", type: "simple", wholesale_only: false }];
  await assert.rejects(validateSelection([1, 2], async () => ({ ids: [1, 2], products: summaries })),
    (error) => error instanceof CatalogError && /wholesale-only/.test(error.message) && /T-1 Tester/.test(error.message) && !/SKU-2/.test(error.message));
  await validateSelection([2], async () => ({ ids: [2], products: [summaries[1]] }));
  const result = await selectedProducts([1, 2], async () => ({ ids: [1, 2], products: summaries }));
  assert.deepEqual(result, [{ id: 1, name: "T-1 Tester", sku: "T-1", price: "0", type: "simple", wholesaleOnly: true },
    { id: 2, name: "SKU-2 Product", sku: "SKU-2", price: "12.50", type: "simple" }]);
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

test("protected dev upload images use the public originals without rewriting other hosts or paths", async () => {
  const sources = [
    "https://dev.ultralove.ca/wp-content/uploads/1513.jpg",
    "https://res.cloudinary.com/supplier/image/upload/product.jpg",
    "https://ultralove.ca/wp-content/uploads/product.jpg",
    "https://dev.ultralove.ca/not-an-upload.jpg",
    "https://example.com/?url=https://dev.ultralove.ca/wp-content/uploads/product.jpg",
  ];
  const result = await productsPage({}, async () => page([{ ...product, images: sources.map((src) => ({ src, alt: "Product image" })) }]));
  assert.deepEqual(result.products[0].images.map((image) => image.src), [
    "https://ultralove.ca/wp-content/uploads/1513.jpg", ...sources.slice(1),
  ]);
  assert.equal(result.products[0].images[0].alt, "Product image");
});

test("selection must be fully confirmed before saving; empty selection needs no feed request", async () => {
  await validateSelection([], async () => { throw new Error("Unexpected request"); });
  await validateSelection([1, 2], async () => ({ids: [2, 1]}));
  for (const ids of [[1], [1, 1], [1, "2"], [1, 2, 3]]) {
    await assert.rejects(validateSelection([1, 2], async () => ({ids})));
  }
});

test("large selections are fully validated in bounded supplier batches", async () => {
  const ids = Array.from({ length: 125 }, (_, index) => index + 1);
  const batches = [];
  await validateSelection(ids, async (request) => {
    assert.equal(request.operation, "selection");
    batches.push(request.ids);
    return { ids: request.ids.toReversed() };
  });
  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 25]);
  assert.deepEqual(batches.flat(), ids);
  let calls = 0;
  await assert.rejects(validateSelection(ids, async (request) => {
    calls++;
    return { ids: calls === 2 ? request.ids.slice(1) : request.ids };
  }), /no longer published/);
  assert.equal(calls, 2, "a later incomplete batch must not be accepted");
  await assert.rejects(validateSelection(ids, async (request) => {
    if (request.ids[0] > 50) throw new CatalogError("Supplier rate limit", 30);
    return { ids: request.ids };
  }), (error) => error instanceof CatalogError && error.retryAfter === 30);
});

test("selected product summaries use bounded complete read-only selections", async () => {
  const ids = Array.from({ length: 50 }, (_, index) => index + 1);
  const summaries = ids.map((id) => ({ id, name: `Name ${id}`, sku: `SKU-${id}`, price: "12.50", type: "simple" }));
  const result = await selectedProducts(ids, async (request) => {
    assert.deepEqual(request, { operation: "selection", ids });
    return { ids: ids.toReversed(), products: summaries.toReversed() };
  });
  assert.deepEqual(result, summaries.toReversed());
  const unavailable = async () => { throw new Error("Invalid input must not reach supplier"); };
  for (const invalid of [[], [...ids, 51], [1, 1], [-1], ["1"]]) await assert.rejects(selectedProducts(invalid, unavailable));
  for (const response of [
    { ids }, { ids: ids.slice(1), products: summaries }, { ids, products: summaries.slice(1) },
    { ids: [...ids.slice(1), 999], products: summaries },
    { ids, products: [summaries[0], ...summaries.slice(0, -1)] },
    { ids, products: [{ ...summaries[0], id: 999 }, ...summaries.slice(1)] },
    { ids, products: [{ ...summaries[0], name: null }, ...summaries.slice(1)] },
    { ids, products: [{ ...summaries[0], price: 12.50 }, ...summaries.slice(1)] },
  ]) await assert.rejects(selectedProducts(ids, async () => response), (error) => error instanceof CatalogError);
  await assert.rejects(selectedProducts(ids, async () => { throw new CatalogError("Supplier rate limit", 30); }),
    (error) => error.retryAfter === 30);
});

test("restricted inventory transport accepts only bounded structured rate-limit failures", async (context) => {
  const previousHost = process.env.CATALOG_SSH_HOST;
  process.env.CATALOG_SSH_HOST = "127.0.0.1";
  let output;
  context.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    assert.equal(file, "/usr/bin/ssh");
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.equal(options.timeout, 150000);
    queueMicrotask(() => callback(Object.assign(new Error("SSH failed"), { code: 1 }), output));
    return { stdin: new PassThrough() };
  });

  test("inventory batching uses one restricted supplier operation and requires every exact parent identity", async () => {
    const generation = "00000000-0000-4000-8000-000000000001";
    const products = [100, 200, 300, 400, 500].map((supplierId, index) => ({
      supplierId, checkpoint: index ? { generation, cursor: index } : null,
    }));
    let calls = 0;
    const results = products.map(product => ({ parent_id: product.supplierId }));
    assert.deepEqual(await inventoryStates(products, async (request) => {
      calls++;
      assert.deepEqual(request, { operation: "inventory-sync-batch", ids: products.map(product => product.supplierId),
        checkpoints: Object.fromEntries(products.map(product => [product.supplierId, product.checkpoint])) });
      return { results: results.toReversed() };
    }), results);
    assert.equal(calls, 1, "five products really share one supplier SSH request");
    for (const response of [
      { results: results.slice(1) }, { results: [results[0], ...results.slice(0, -1)] },
      { results: [{ parent_id: "100" }, ...results.slice(1)] },
      { results: [{ parent_id: 999 }, ...results.slice(1)] }, { results: [null, ...results.slice(1)] },
      null, { products: results },
    ]) await assert.rejects(inventoryStates(products, async () => response), CatalogError);
    for (const input of [[], [products[0], products[0]], [{ supplierId: -1, checkpoint: null }],
      Array.from({ length: 51 }, (_, index) => ({ supplierId: index + 1, checkpoint: null }))]) {
      await assert.rejects(inventoryStates(input, async () => { throw new Error("Invalid bounds must not reach supplier"); }), CatalogError);
    }
    const single = await inventoryStates([products[0]], async request => {
      assert.deepEqual(request, { operation: "inventory-sync", ids: [100], checkpoint: null });
      return results[0];
    });
    assert.deepEqual(single, [results[0]], "single-product transport remains compatible with the installed proxy");
    await assert.rejects(inventoryStates(products, async () => { throw new CatalogError("Supplier rate limit", 3600); }),
      error => error.retryAfter === 3600);
  });
  syncBuiltinESMExports();
  try {
    for (const [body, delay] of [
      ['{"error":{"status":429,"retryAfter":3600}}', 3600],
      ['{"error":{"status":429,"retryAfter":0}}', null],
      ['{"error":{"status":429,"retryAfter":-1}}', null],
      ['{"error":{"status":429,"retryAfter":1.5}}', null],
      ['{"error":{"status":429,"retryAfter":2147483648}}', null],
      ['{"error":{"status":429,"retryAfter":"3600"}}', null],
      ['{"error":{"status":500,"retryAfter":3600}}', null],
      ["not JSON", null],
      ["", null],
      ['{"error":{"status":500,"code":"SELECTED_PRODUCT_UNAVAILABLE"}}', null],
      ['{"error":{"status":409,"code":"UNTRUSTED_MESSAGE","message":"private supplier details"}}', null],
    ]) {
      output = body;
      await assert.rejects(inventoryState(100, null), (error) =>
        error instanceof CatalogError && error.retryAfter === delay &&
        (delay === null ? /unavailable/.test(error.message) : /3600 seconds/.test(error.message)));
    }
    output = '{"error":{"status":409,"code":"WHOLESALE_ONLY"}}';
    await assert.rejects(importPlan([68951], "gid://shopify/Location/1", "a".repeat(32), "25.00"), (error) =>
      error instanceof CatalogError && error.retryAfter === null && /wholesale-only/.test(error.message) && /nothing was imported/.test(error.message));
    output = '{"error":{"status":409,"code":"SELECTED_PRODUCT_UNAVAILABLE"}}';
    for (const operation of [
      () => selectedProducts([68951]),
      () => validateSelection([68951]),
      () => importPlan([68951], "gid://shopify/Location/1", "a".repeat(32), "25.00"),
    ]) {
      await assert.rejects(operation(), error => error instanceof CatalogError && error.retryAfter === null &&
        /no longer published or available/.test(error.message) && !/connection is unavailable/.test(error.message));
    }
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousHost === undefined) delete process.env.CATALOG_SSH_HOST;
    else process.env.CATALOG_SSH_HOST = previousHost;
  }
});

test("category filter lists every supplier category sorted by name", async () => {
  const pages = {
    0: {categories: [{id: 3, name: "vibrators"}, {id: 7, name: "Bath &amp; Body"}], next_after_id: 7, has_more: true},
    7: {categories: [{id: 9, name: "Anal Toys"}, {id: 12, name: "Lube 10"}, {id: 14, name: "Lube 2"}], next_after_id: 14, has_more: false},
  };
  const result = await allCategories(async (request) => pages[request.filters.after_id]);
  assert.deepEqual(result.categories.map((category) => category.id), [9, 7, 14, 12, 3]);
  await assert.rejects(allCategories(async () => ({categories: [], next_after_id: 0, has_more: true})), CatalogError);
});
