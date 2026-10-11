import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { createServer } from "vite";

test("listing review shows selected updates, immutable differences and actionable missing-product recovery", async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom" });
  try {
    const { default: Results } = await server.ssrLoadModule("/app/import-results.tsx");
    const { default: Options } = await server.ssrLoadModule("/app/listing-options.tsx");
    const { defaultListingPolicy } = await server.ssrLoadModule("/app/listing-policy.ts");
    const policy = { ...defaultListingPolicy(), mode: "UPDATE", content: true, prices: true };
    const job = {
      id: "a".repeat(32), status: "PREVIEW", markup: "25.00", markups: {}, createdAt: new Date().toISOString(),
      active: false, publicationId: null, confirmation: "reviewed-update", listingPolicy: policy,
      error: null, generation: "fixture", cursor: 1,
      items: [{ supplierId: 100, name: "Amber case", sku: "AMBER", status: "PENDING", markup: "25.00",
        productId: "gid://shopify/Product/123", error: null, attempts: 0, wholesale: "10.00 CAD", retail: "12.50 CAD",
        variantCount: 1, warnings: [], listing: { action: "UPDATE", targetId: "gid://shopify/Product/123", message: null,
          changes: [{ field: "Title", before: "Retailer title", after: "<b>Supplier title</b>" }] } }],
    };
    const render = async (current, draftPolicy = policy) => {
      const handler = createStaticHandler([{ id: "review", path: "/app", loader: () => ({}), Component: () => createElement(Results, {
        job: current, history: [], ids: [100], markup: "25.00", markups: {}, listingPolicy: draftPolicy,
        activeChoice: false, publishChoice: false, busy: false, jobHref: () => "/app", mode: "review",
        selectionHref: "/app?view=selection", catalogHref: "/app", inventoryHref: "/app/inventory",
      }) }]);
      const context = await handler.query(new Request("https://fixture.example/app"));
      return renderToStaticMarkup(createElement(StaticRouterProvider, { context, router: createStaticRouter(handler.dataRoutes, context) }));
    };
    const updated = await render(job);
    assert.match(updated, /Update selected fields/);
    assert.match(updated, /Retailer title/);
    assert.match(updated, /&lt;b&gt;Supplier title&lt;\/b&gt;/, "supplier HTML is displayed as text, not injected");
    assert.match(updated, /preserve their publication and inventory/);
    assert.doesNotMatch(updated, /Not applied to existing listing/);
    const blocked = await render({ ...job, items: [{ ...job.items[0], productId: null,
      listing: { action: "BLOCKED", targetId: null, changes: [], message: "Previously linked Shopify product could not be found." } }] });
    assert.match(blocked, /Resolve product connections/);
    assert.match(blocked, /name="link-100"/);
    assert.match(blocked, /name="recreate-100"/);
    assert.match(blocked, /Validate connections and create fresh review/);
    assert.match(blocked, /<input(?=[^>]*name="confirm")(?=[^>]*disabled="")[^>]*>/);
    const changed = await render(job, defaultListingPolicy());
    assert.match(changed, /Your selection, pricing, or import choices have changed/);
    assert.match(changed, /<input(?=[^>]*name="confirm")(?=[^>]*disabled="")[^>]*>/);
    const completed = await render({ ...job, status: "COMPLETE", items: [{ ...job.items[0], status: "UPDATED" }] });
    assert.match(completed, /1 of 1 products completed/);
    assert.match(completed, /Updated from UltraLove/);
    const expiredUpdate = await render({ ...job, status: "FAILED",
      createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      items: [{ ...job.items[0], status: "FAILED", error: "Listing snapshot expired." }] });
    assert.match(expiredUpdate, /This pricing preview has expired/);
    assert.match(expiredUpdate, /<input(?=[^>]*name="confirm")(?=[^>]*disabled="")[^>]*>/);
    assert.match(expiredUpdate, /Validate connections and create fresh review/);
    const defaultOptions = renderToStaticMarkup(createElement(Options, { policy: defaultListingPolicy(), disabled: false, onChange: () => {} }));
    assert.match(defaultOptions, /Keep unchanged \(recommended\)/);
    assert.match(defaultOptions, /Markup applies only to new products/);
    const updateOptions = renderToStaticMarkup(createElement(Options, { policy, disabled: false, onChange: () => {} }));
    assert.match(updateOptions, /Add supplier images/);
    assert.match(updateOptions, /Product and variant IDs, URLs, publication/);
  } finally { await server.close(); }
});
