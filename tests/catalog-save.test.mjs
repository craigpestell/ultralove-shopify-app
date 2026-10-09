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
          export const validation = { calls: [], reject: false, browseCalls: 0, browseReject: false };
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
    const request = (fields) => new Request("https://app.example/app?category_id=5", {
      method: "POST", body: new URLSearchParams(fields),
    });
    const fields = (ids) => [["intent", "save-selection"], ["ids", JSON.stringify(ids)]];

    for (const ids of [[3, 1, 2], []]) {
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
      fields([1, 1]), fields(["1"]), fields(Array.from({ length: 51 }, (_, i) => i + 1)),
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
    const handler = createStaticHandler([{
      id: "catalog", path: "/app", Component: () => createElement(WorkspaceProvider, {
        shop, saved: { selected: [1], markup: "25.00", markups: {} },
      }, createElement(Index)),
      loader: async () => ({
        shop, selected: [1], markup: "25.00", markups: {}, job: null, history: [], filters: { categoryAfter: 0 },
        products: { products: [], next_after_id: 0, has_more: false },
        categories: { categories: [], next_after_id: 0, has_more: false }, error: null,
      }),
    }]);
    const context = await handler.query(new Request("https://app.example/app"));
    const router = createStaticRouter(handler.dataRoutes, context);
    const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router, context }));
    assert.match(html, /Save changes/);
    assert.match(html, /Selection &amp; pricing/);
    assert.match(html, /Supplier catalog/);
    assert.match(html, /1 outside this page/);
    assert.doesNotMatch(html, /href="\/app\/imports/);
    assert.doesNotMatch(html, /name="confirm"/, "confirmation is deliberately staged after pricing");
  } finally {
    await server.close();
  }
});
