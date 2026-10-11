import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { createServer } from "vite";

test("unified catalog saves validated selections in place and keeps failures on the same page", async () => {
  const shop = "ultralove-integration-lab.myshopify.com";
  const server = await createServer({
    configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom",
    plugins: [{
      name: "test-catalog-save",
      enforce: "pre",
      load(id) {
        if (id.endsWith("/app/shopify.server.ts")) return `
          export const auth = { reject: false };
          export async function authenticateLabAdmin() {
            if (auth.reject) throw new Response("Forbidden", {status:403});
            return {session:{shop:${JSON.stringify(shop)}}};
          }`;
        if (id.endsWith("/app/db.server.ts")) return `
          export const persistence = { writes: [], reject: false };
          export default { catalogSelection: { async upsert(input) {
            if (persistence.reject) throw new Error("Persistence unavailable");
            persistence.writes.push(input);
            return input.create;
          } } };`;
        if (id.endsWith("/app/imports.server.ts")) return `
          export const imports = { previews: [], queued: [] };
          export async function createPreview(...args) {
            imports.previews.push(args);
            return {id:"${"a".repeat(32)}"};
          }
          export async function queueJob(...args) { imports.queued.push(args); }
          export async function importScreen() { return {
            selected:[1],markup:"25.00",markups:{},job:null,history:[]
          }; }`;
        if (id.endsWith("/app/catalog.server.ts")) return `
          export class CatalogError extends Error {}
          export const validation = { calls: [], reject: false, browseCalls: 0, browseReject: false, detailsCalls: [], detailsReject: false };
          export async function selectedProducts(ids) {
            validation.detailsCalls.push(ids);
            if (validation.detailsReject) throw new CatalogError("Details unavailable");
            return ids.map(id=>({id,name:"Product "+id,sku:"SKU-"+id,price:"12.50",type:"simple"}));
          }
          export async function validateSelection(ids) {
            validation.calls.push(ids);
            if (validation.reject) throw new CatalogError("Selection no longer available");
          }
          export async function productsPage() {
            validation.browseCalls++;
            if (validation.browseReject) throw new CatalogError("Feed unavailable");
          }
          export async function categoriesPage() {
            validation.browseCalls++;
            if (validation.browseReject) throw new CatalogError("Feed unavailable");
          }`;
      },
    }],
  });
  try {
    const { action, default: Index, loader } = await server.ssrLoadModule("/app/routes/app._index.tsx");
    const { persistence } = await server.ssrLoadModule("/app/db.server.ts");
    const { validation } = await server.ssrLoadModule("/app/catalog.server.ts");
    const { auth } = await server.ssrLoadModule("/app/shopify.server.ts");
    const { imports } = await server.ssrLoadModule("/app/imports.server.ts");
    const { loader: detailsLoader } = await server.ssrLoadModule("/app/routes/app.selection-details.ts");
    const detailsRequest = (value) => new Request(`https://app.example/app/selection-details?ids=${encodeURIComponent(value)}`);
    let details = await detailsLoader({ request: detailsRequest("[2,1]") });
    assert.deepEqual(details.data.products.map(product => product.id), [1, 2]);
    assert.equal(details.init.headers["Cache-Control"], "no-store");
    const detailCalls = validation.detailsCalls.length;
    for (const invalid of ["", "no JSON", "[]", "[1,1]", '["1"]', JSON.stringify(Array.from({length: 51}, (_, i) => i + 1))]) {
      details = await detailsLoader({ request: detailsRequest(invalid) });
      assert.equal(details.init.status, 400);
      assert.ok(details.data.error);
    }
    assert.equal((await detailsLoader({ request: new Request("https://app.example/app/selection-details?ids=[1]&ids=[2]") })).init.status, 400);
    assert.equal(validation.detailsCalls.length, detailCalls);
    auth.reject = true;
    await assert.rejects(detailsLoader({ request: detailsRequest("[1]") }), (error) => error.status === 403);
    assert.equal(validation.detailsCalls.length, detailCalls, "supplier details are never read before authentication");
    auth.reject = false;
    validation.detailsReject = true;
    details = await detailsLoader({ request: detailsRequest("[1]") });
    assert.equal(details.init.status, 502);
    assert.equal(details.data.error, "Details unavailable");
    validation.detailsReject = false;
    const request = (fields) => new Request("https://app.example/app?category_id=5", {
      method: "POST", body: new URLSearchParams(fields),
    });
    const fields = (ids) => [["intent", "save-selection"], ["ids", JSON.stringify(ids)]];

    const largeIds = Array.from({ length: 1250 }, (_, index) => index + 1);
    for (const ids of [[3, 1, 2], [], largeIds]) {
      const result = await action({ request: request(fields(ids)) });
      assert.equal(result.data.saved, true);
      assert.equal(result.data.error, null);
      const expected = JSON.stringify([...ids].sort((a, b) => a - b));
      assert.deepEqual(persistence.writes.at(-1), {
        where: { shop },
        create: { shop, productIds: expected, markups: "{}" },
        update: { productIds: expected, markups: "{}" },
      });
      assert.equal(JSON.stringify(validation.calls.at(-1)), expected);
    }
    const writes = persistence.writes.length;
    const validations = validation.calls.length;
    for (const invalid of [
      [["intent", "wrong"], ["ids", "[1]"]],
      [...fields([1]), ["ids", "[2]"]],
      [["intent", "save-selection"], ["ids", "invalid JSON"]],
      fields([1, 1]), fields(["1"]),
    ]) {
      const result = await action({ request: request(invalid) });
      assert.equal(result.init.status, 400);
      assert.ok(result.data.error);
      assert.equal(persistence.writes.length, writes);
      assert.equal(validation.calls.length, validations);
    }
    validation.reject = true;
    const unavailable = await action({ request: request(fields([1])) });
    assert.equal(unavailable.init.status, 502);
    assert.equal(unavailable.data.error, "Selection no longer available");
    assert.equal(persistence.writes.length, writes);
    validation.reject = false;
    persistence.reject = true;
    await assert.rejects(action({ request: request(fields([1])) }), /Persistence unavailable/);
    assert.equal(persistence.writes.length, writes);
    persistence.reject = false;
    auth.reject = true;
    await assert.rejects(action({ request: request(fields([1])) }), (error) => error.status === 403);
    assert.equal(persistence.writes.length, writes);
    auth.reject = false;

    const configuration = [["intent", "save-configuration"], ["ids", "[1,2]"], ["markup", "25"],
      ["markups", '{"2":"50.5"}']];
    const saved = await action({ request: request(configuration) });
    assert.equal(saved.data.saved, true);
    assert.deepEqual(persistence.writes.at(-1).update, {
      productIds: "[1,2]", markup: "25.00", markups: '{"2":"50.50"}',
    });
    const preview = await action({ request: request(configuration.map(([key, value]) => [key, key === "intent" ? "preview" : value])) });
    assert.equal(preview.headers.get("Location"), `/app?category_id=5&job=${"a".repeat(32)}&view=review`);
    assert.deepEqual(imports.previews.at(-1)[4], { ids: [1, 2], markups: { 2: "50.50" } });
    assert.deepEqual(imports.previews.at(-1)[3], { active: false, publish: false });
    const listingPolicy = { mode: "UPDATE", content: true, images: false, prices: true,
      links: { 1: "https://admin.shopify.com/store/ultralove-integration-lab/products/123" }, recreate: [2] };
    const updatePreview = await action({ request: request([
      ...configuration.map(([key, value]) => [key, key === "intent" ? "preview" : value]),
      ["listing-policy", JSON.stringify(listingPolicy)],
    ]) });
    assert.equal(updatePreview.status, 302);
    assert.deepEqual(imports.previews.at(-1)[5], { ...listingPolicy, links: { 1: "gid://shopify/Product/123" } });
    const policyPreviewCount = imports.previews.length;
    for (const policy of [
      "bad", JSON.stringify({ ...listingPolicy, mode: "wrong" }),
      JSON.stringify({ ...listingPolicy, content: false, prices: false }),
      JSON.stringify({ ...listingPolicy, links: { 3: "123" } }),
      JSON.stringify({ ...listingPolicy, links: { 1: "https://evil.example/products/123" } }),
      JSON.stringify({ ...listingPolicy, recreate: [1] }),
    ]) {
      const rejected = await action({ request: request([
        ...configuration.map(([key, value]) => [key, key === "intent" ? "preview" : value]),
        ["listing-policy", policy],
      ]) });
      assert.equal(rejected.init.status, 400);
      assert.ok(rejected.data.error);
      assert.equal(imports.previews.length, policyPreviewCount);
    }
    const duplicatedPolicy = await action({ request: request([
      ...configuration.map(([key, value]) => [key, key === "intent" ? "preview" : value]),
      ["listing-policy", JSON.stringify(listingPolicy)], ["listing-policy", JSON.stringify(listingPolicy)],
    ]) });
    assert.equal(duplicatedPolicy.init.status, 400);
    const largeOverrides = Object.fromEntries(largeIds.map((id) => [id, "25.5"]));
    const largeConfiguration = [["intent", "preview"], ["ids", JSON.stringify(largeIds)],
      ["markup", "10"], ["markups", JSON.stringify(largeOverrides)]];
    assert.ok(largeConfiguration[1][1].length > 1000);
    assert.ok(largeConfiguration[3][1].length > 5000);
    const largePreview = await action({ request: request(largeConfiguration) });
    assert.equal(largePreview.status, 302);
    assert.equal(imports.previews.at(-1)[4].ids.length, 1250);
    assert.equal(Object.keys(imports.previews.at(-1)[4].markups).length, 1250);
    await action({ request: request([["intent", "preview"], ["markup", "25"]]) });
    assert.equal(imports.previews.at(-1)[4], undefined, "legacy previews remain global-only");
    const previewCount = imports.previews.length;
    const writeCount = persistence.writes.length;
    for (const changed of [
      ["markups", '{"3":"25"}'], ["markups", '{"1":"-1"}'], ["markups", '{"1":"1000.01"}'],
      ["markups", '{"1":"25.001"}'], ["markups", "[]"], ["markups", "invalid"],
      ["markup", "25.001"],
    ]) {
      const invalid = configuration.map(([key, value]) => [key, key === changed[0] ? changed[1] : value]);
      const rejected = await action({ request: request(invalid) });
      assert.equal(rejected.init.status, 400);
      assert.equal(persistence.writes.length, writeCount);
      assert.equal(imports.previews.length, previewCount);
    }
    for (const intent of ["queue", "retry"]) {
      const response = await action({ request: request([["intent", intent], ["job", "a".repeat(32)], ["confirm", "draft-only"]]) });
      assert.equal(response.headers.get("Location"), `/app?category_id=5&job=${"a".repeat(32)}&view=imports`);
      assert.deepEqual(imports.queued.at(-1), [shop, "a".repeat(32), intent === "retry", "draft-only"]);
    }
    for (const query of ["?job=bad", `?job=${"a".repeat(32)}&job=${"b".repeat(32)}`]) {
      await assert.rejects(loader({ request: new Request(`https://app.example/app${query}`) }), (error) => error.status === 400);
    }
    validation.browseReject = true;
    for (const query of ["?view=imports", `?view=review&job=${"a".repeat(32)}`, `?job=${"a".repeat(32)}`]) {
      const screen = await loader({ request: new Request(`https://app.example/app${query}`) });
      assert.equal(screen.products, null);
      assert.equal(screen.error, null);
    }
    assert.equal(validation.browseCalls, 0, "review and recovery must not depend on supplier browsing");
    validation.browseReject = false;
    const { loader: legacyLoader, action: legacyAction } = await server.ssrLoadModule("/app/routes/app.imports.tsx");
    const legacyResponse = await legacyLoader({ request: new Request(`https://app.example/app/imports?job=${"a".repeat(32)}&host=fixture&shop=${shop}`) });
    assert.equal(legacyResponse.headers.get("Location"), `/app?job=${"a".repeat(32)}&host=fixture&shop=${shop}&view=imports`);
    assert.equal((await legacyAction({ request: request([["intent", "preview"], ["markup", "25"]]) })).status, 302);
    auth.reject = true;
    await assert.rejects(legacyLoader({ request: new Request("https://app.example/app/imports") }), (error) => error.status === 403);
    auth.reject = false;

    const { WorkspaceProvider } = await server.ssrLoadModule("/app/workspace.tsx");
    let catalogProducts = [];
    let renderSelected = [1];
    const handler = createStaticHandler([{
      id: "catalog", path: "/app", Component: () => createElement(WorkspaceProvider, {
        shop, saved: { selected: renderSelected, markup: "25.00", markups: {} },
      }, createElement(Index)),
      loader: async () => ({
        shop, selected: renderSelected, markup: "25.00", markups: {}, job: null, history: [], filters: { categoryAfter: 0 },
        products: { products: catalogProducts, next_after_id: 0, has_more: false },
        categories: { categories: [], next_after_id: 0, has_more: false }, error: null,
      }),
    }]);
    const context = await handler.query(new Request("https://app.example/app"));
    const router = createStaticRouter(handler.dataRoutes, context);
    const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router, context }));
    assert.match(html, /Save changes/);
    assert.match(html, /Selection &amp; pricing/);
    assert.match(html, /UltraLove&#x27;s catalog/);
    assert.match(html, /aria-label="UltraLove&#x27;s catalog"/);
    assert.match(html, /1 outside this page/);
    assert.doesNotMatch(html, /href="\/app\/imports/);
    assert.doesNotMatch(html, /name="confirm"/, "confirmation is deliberately staged after pricing");
    catalogProducts = [
      { id: 1, stock_quantity: 7 },
      { id: 2, stock_quantity: 0 },
      { id: 3, manage_stock: false },
      { id: 4, type: "variable" },
      { id: 5, stock_quantity: null },
      { id: 6, stock_owner_id: 999 },
    ].map((product) => ({ name: `Product ${product.id}`, sku: `SKU-${product.id}`, images: [], price: "10.00",
      type: "simple", manage_stock: true, stock_quantity: 10, stock_owner_id: product.id, ...product }));
    const stockedContext = await handler.query(new Request("https://app.example/app"));
    const stockedHtml = renderToStaticMarkup(createElement(StaticRouterProvider, {
      router: createStaticRouter(handler.dataRoutes, stockedContext), context: stockedContext,
    }));
    assert.match(stockedHtml, />7 units<\/td>/);
    assert.doesNotMatch(stockedHtml, /supplier units/);
    assert.match(stockedHtml, /Availability is UltraLove stock, not Shopify inventory/);
    assert.match(stockedHtml, /Out of stock/);
    assert.match(stockedHtml, /Stock varies by variant/);
    assert.match(stockedHtml, /Unmanaged.*needs review/);
    assert.equal((stockedHtml.match(/Unknown\/shared.*?needs review/g) ?? []).length, 2);
    renderSelected = Array.from({ length: 300 }, (_, i) => i + 1);
    const selectionContext = await handler.query(new Request("https://app.example/app?view=selection"));
    const selectionHtml = renderToStaticMarkup(createElement(StaticRouterProvider, {
      router: createStaticRouter(handler.dataRoutes, selectionContext), context: selectionContext,
    }));
    assert.equal((selectionHtml.match(/class="selection-product-name"/g) ?? []).length, 25);
    assert.match(selectionHtml, /Search selected products/);
    assert.match(selectionHtml, /Page 1 of 12/);
    assert.match(selectionHtml, /name="ids" value="\[1,2,3,/, "the configuration form includes the complete selection, not just its first page");
    assert.match(selectionHtml, /298,299,300\]"/);
  } finally {
    await server.close();
  }
});
