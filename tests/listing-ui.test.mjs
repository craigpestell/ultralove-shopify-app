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
        job: current, history: [], ids: current.items.map((item) => item.supplierId), markup: "25.00", markups: {}, listingPolicy: draftPolicy,
        activeChoice: false, publishChoice: false, busy: false, jobHref: () => "/app", mode: "review",
        selectionHref: "/app?view=selection", catalogHref: "/app", inventoryHref: "/app/inventory",
      }) }]);
      const context = await handler.query(new Request("https://fixture.example/app"));
      return renderToStaticMarkup(createElement(StaticRouterProvider, { context, router: createStaticRouter(handler.dataRoutes, context) }));
    };
    const updated = await render(job);
    assert.match(updated, /<td><span class="catalog-money">10\.00 CAD<\/span><\/td>/);
    assert.match(updated, /<td><strong class="catalog-money">12\.50 CAD<\/strong><\/td>/);
    const ranges = await render({ ...job, items: [{ ...job.items[0],
      wholesale: "0.44 - 1,234.50 CAD", retail: "0.55 - 1,543.13 CAD" }] });
    assert.match(ranges, /<span class="catalog-money">0\.44 - 1,234\.50 CAD<\/span>/);
    assert.match(ranges, /<strong class="catalog-money">0\.55 - 1,543\.13 CAD<\/strong>/);
    assert.match(updated, /Update selected fields/);
    assert.match(updated, /Retailer title/);
    assert.match(updated, /Review 1 proposed change\(s\)/);
    assert.match(updated, /<small>Current<\/small>/);
    assert.match(updated, /<small>Proposed<\/small>/);
    assert.match(updated, /&lt;b&gt;Supplier title&lt;\/b&gt;/, "supplier HTML is displayed as text, not injected");
    assert.match(updated, /preserve their publication and inventory/);
    assert.doesNotMatch(updated, /Not applied to existing listing/);
    const blocked = await render({ ...job, items: [{ ...job.items[0], productId: null,
      listing: { action: "BLOCKED", targetId: null, changes: [], message: "Previously linked Shopify product could not be found." } }] });
    assert.match(blocked, /Resolve product connections/);
    assert.match(blocked, /name="link-100"/);
    assert.doesNotMatch(blocked, /name="recreate-100"/);
    assert.match(blocked, /Validate connections and create fresh review/);
    assert.match(blocked, /<input(?=[^>]*name="confirm")(?=[^>]*disabled="")[^>]*>/);
    const replacement = await render({ ...job, listingPolicy: defaultListingPolicy(),
      items: [{ ...job.items[0], productId: null, listing: { action: "RECREATE", targetId: null,
        changes: [], message: "The previously linked product is confirmed missing." } }] }, defaultListingPolicy());
    assert.match(replacement, /Create replacement/);
    assert.match(replacement, /Review replacements/);
    assert.match(replacement, /new product and variant IDs/);
    assert.match(replacement, /This confirmation also authorizes the 1 reviewed replacement/);
    assert.match(replacement, /<input(?=[^>]*name="confirm")(?![^>]*disabled)[^>]*>/,
      "automatic replacements can be confirmed without a second recovery preview");
    assert.doesNotMatch(replacement, /name="recreate-100"/);
    assert.match(replacement, /Show only products needing review \(1\)/);
    const completedReplacement = await render({ ...job, status: "COMPLETE", listingPolicy: defaultListingPolicy(),
      items: [{ ...job.items[0], status: "CREATED",
        listing: { action: "RECREATE", targetId: null, changes: [], message: null } }] }, defaultListingPolicy());
    assert.doesNotMatch(completedReplacement, /Show only products needing review/);
    const changed = await render(job, defaultListingPolicy());
    assert.match(changed, /Your selection, pricing, or import choices have changed/);
    assert.match(changed, /<input(?=[^>]*name="confirm")(?=[^>]*disabled="")[^>]*>/);
    const completed = await render({ ...job, status: "COMPLETE", items: [{ ...job.items[0], status: "UPDATED" }] });
    assert.match(completed, /<span class="catalog-money">10\.00 CAD<\/span>/);
    assert.match(completed, /<strong class="catalog-money">12\.50 CAD<\/strong>/);
    assert.match(completed, /1 of 1 products completed/);
    assert.match(completed, /Updated from UltraLove/);
    assert.match(completed, /1 applied change\(s\)/);
    assert.match(completed, /<small>Before<\/small>/);
    assert.match(completed, /<small>After<\/small>/);
    assert.doesNotMatch(completed, /proposed change|<small>Current<\/small>|<small>Proposed<\/small>/);
    for (const status of ["RUNNING", "FAILED", "COMPLETE"]) {
      for (const itemStatus of ["UPDATED", "LINKED"]) {
        const applied = await render({ ...job, status, items: [{ ...job.items[0], status: itemStatus,
          listing: { ...job.items[0].listing, action: itemStatus === "LINKED" ? "LINK" : "UPDATE",
            changes: [
              { field: "Product name", before: "2455  The Ultimate Kiss  Oral Lovemaking Book WHILE STOCK LASTS",
                after: "2455 The Ultimate Kiss Oral Lovemaking Book" },
              { field: "Add supplier image", before: "", after: "https://ultralove.ca/wp-content/uploads/2021/04/products-2455.jpg" },
            ] } }] });
        assert.match(applied, /2 applied change\(s\)/);
        assert.match(applied, /<small>Before<\/small><pre>\(empty\)<\/pre>/);
        assert.match(applied, /<small>After<\/small><pre>https:\/\/ultralove.ca\/wp-content\/uploads\/2021\/04\/products-2455.jpg<\/pre>/);
        assert.doesNotMatch(applied, /proposed change|<small>Current<\/small>|<small>Proposed<\/small>/);
      }
    }
    for (const itemStatus of ["PENDING", "RUNNING", "FAILED"]) {
      const unfinished = await render({ ...job, status: "FAILED", items: [{ ...job.items[0], status: itemStatus }] });
      assert.match(unfinished, /Review 1 proposed change\(s\)/);
      assert.doesNotMatch(unfinished, /applied change/);
    }
    const expiredUpdate = await render({ ...job, status: "FAILED",
      createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      items: [{ ...job.items[0], status: "FAILED", error: "Listing snapshot expired." }] });
    assert.match(expiredUpdate, /This pricing preview has expired/);
    assert.match(expiredUpdate, /<input(?=[^>]*name="confirm")(?=[^>]*disabled="")[^>]*>/);
    assert.match(expiredUpdate, /Validate connections and create fresh review/);
    const largeJob = { ...job, items: Array.from({ length: 300 }, (_, index) => ({
      ...job.items[0], supplierId: index + 1, name: `Product ${index + 1}`, sku: `SKU-${index + 1}`, productId: null,
      listing: { action: "CREATE", targetId: null, changes: [], message: null },
    })) };
    for (const current of [largeJob, { ...largeJob, status: "FAILED",
      items: largeJob.items.map((item) => ({ ...item, status: "FAILED", error: "Retry required." })) }]) {
      const large = await render(current);
      const body = large.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
      assert.equal((body.match(/<tr>/g) || []).length, 25);
      assert.equal((large.match(/<fieldset /g) || []).length, 25);
      assert.ok(large.indexOf('class="catalog-confirmation') < large.indexOf("<table>"),
        "confirmation and retry are reachable before the results");
      assert.ok(large.indexOf("Validate connections and create fresh review") < large.indexOf("<fieldset "),
        "fresh-review action precedes connection fields");
      assert.match(large, /Applies to all 300 products in this snapshot/);
      assert.match(large, /Showing 1–25 of 300 matching products/);
      assert.match(large, /Page 1 of 12/);
      assert.ok(large.includes(`name="ids" value="${JSON.stringify(current.items.map((item) => item.supplierId))}"`),
        "connection recovery submits every snapshot ID, not just the page");
      assert.match(large, /<input(?=[^>]*name="confirm")(?![^>]*disabled)[^>]*>/);
      if (current.status === "FAILED") assert.match(large, /Retry unfinished items/);
    }
    const defaultOptions = renderToStaticMarkup(createElement(Options, { policy: defaultListingPolicy(), disabled: false, onChange: () => {} }));
    assert.match(defaultOptions, /Keep unchanged \(recommended\)/);
    assert.match(defaultOptions, /Markup applies only to new products/);
    const updateOptions = renderToStaticMarkup(createElement(Options, { policy, disabled: false, onChange: () => {} }));
    assert.match(updateOptions, /Add supplier images/);
    assert.match(updateOptions, /Product and variant IDs, URLs, publication/);
  } finally { await server.close(); }
});
