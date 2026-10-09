import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { createServer } from "vite";

test("catalog saves validated selections before redirecting to pricing and keeps failures on the catalog", async () => {
  const shop = "ultralove-integration-lab.myshopify.com";
  const server = await createServer({
    configFile: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom",
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
        if (id.endsWith("/app/catalog.server.ts")) return `
          export class CatalogError extends Error {}
          export const validation = { calls: [], reject: false };
          export async function validateSelection(ids) {
            validation.calls.push(ids);
            if (validation.reject) throw new CatalogError("Selection no longer available");
          }
          export async function productsPage() {}
          export async function categoriesPage() {}`;
      },
    }],
  });
  try {
    const { action, default: Index } = await server.ssrLoadModule("/app/routes/app._index.tsx");
    const { persistence } = await server.ssrLoadModule("/app/db.server.ts");
    const { validation } = await server.ssrLoadModule("/app/catalog.server.ts");
    const { auth } = await server.ssrLoadModule("/app/shopify.server.ts");
    const request = (fields) => new Request("https://app.example/app?category_id=5", {
      method: "POST", body: new URLSearchParams(fields),
    });
    const fields = (ids) => [["intent", "save-selection"], ["ids", JSON.stringify(ids)]];

    for (const ids of [[3, 1, 2], []]) {
      const result = await action({ request: request(fields(ids)) });
      assert.equal(result.status, 302);
      assert.equal(result.headers.get("Location"), "/app/imports");
      const expected = JSON.stringify([...ids].sort((a, b) => a - b));
      assert.deepEqual(persistence.writes.at(-1), {
        where: { shop },
        create: { shop, productIds: expected },
        update: { productIds: expected },
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

    const handler = createStaticHandler([{
      id: "catalog", path: "/app", Component: Index,
      loader: async () => ({
        shop, selected: [1], filters: { categoryAfter: 0 },
        products: { products: [], next_after_id: 0, has_more: false },
        categories: { categories: [], next_after_id: 0, has_more: false }, error: null,
      }),
    }]);
    const context = await handler.query(new Request("https://app.example/app"));
    const router = createStaticRouter(handler.dataRoutes, context);
    const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router, context }));
    assert.match(html, /<button type="submit">Save selection and review pricing<\/button>/);
    assert.doesNotMatch(html, /Save selection \(no import\)/);
    assert.match(html, /No import runs until you confirm and queue it/);
  } finally {
    await server.close();
  }
});
