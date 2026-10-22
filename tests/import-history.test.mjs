import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { createServer } from "vite";

test("each recent activity row, including its View label, is one link to the job", async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom" });
  try {
    const { default: Results } = await server.ssrLoadModule("/app/import-results.tsx");
    const { defaultListingPolicy } = await server.ssrLoadModule("/app/listing-policy.ts");
    const history = [{ id: "job-1", status: "COMPLETE", total: 2, completed: 2, markup: "25.00", createdAt: new Date().toISOString() }];
    const handler = createStaticHandler([{ id: "imports", path: "/app", loader: () => ({}), Component: () => createElement(Results, {
      job: null, history, ids: [], markup: "25.00", markups: {}, listingPolicy: defaultListingPolicy(),
      activeChoice: false, publishChoice: false, busy: false, jobHref: (id) => `/app?view=imports&job=${id}`, mode: "imports",
      selectionHref: "/app?view=selection", catalogHref: "/app", inventoryHref: "/app/inventory",
    }) }]);
    const context = await handler.query(new Request("https://example.com/app?view=imports"));
    const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
    const row = html.match(/<ul class="job-history">.*?<\/ul>/s)?.[0] ?? "";
    assert.match(row, /<a [^>]*href="\/app\?view=imports&amp;job=job-1"[^>]*>.*View<\/span><\/a>/s);
  } finally {
    await server.close();
  }
});
