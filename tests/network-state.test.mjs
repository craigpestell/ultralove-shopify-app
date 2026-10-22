import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { createServer } from "vite";

test("request feedback shows one state at a time and never hides a failure behind success", async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom" });
  try {
    const { RequestFeedback, PendingLink } = await server.ssrLoadModule("/app/network-state.tsx");
    const render = (props) => renderToStaticMarkup(createElement(RequestFeedback, props));
    assert.equal(render({}), "");
    assert.equal(render({ pending: true }), "", "pending without a message leaves feedback to the button");
    const pending = render({ pending: true, pendingMessage: "Saving", error: "Old failure", success: "Old success" });
    assert.match(pending, /role="status"/);
    assert.match(pending, /<s-spinner/);
    assert.match(pending, /Saving/);
    assert.doesNotMatch(pending, /Old failure|Old success/);
    const failed = render({ error: "Catalog timed out", errorHeading: "Catalog unavailable", success: "Saved" });
    assert.match(failed, /role="alert"/);
    assert.match(failed, /tone="critical"/);
    assert.match(failed, /Catalog unavailable/);
    assert.doesNotMatch(failed, /Saved/);
    const saved = render({ success: "Saved" });
    assert.match(saved, /tone="success"/);

    const handler = createStaticHandler([{ id: "root", path: "/app", loader: () => ({}),
      Component: () => createElement(PendingLink, { to: "/app?view=selection", className: "workspace-primary" }, "Review selection") }]);
    const context = await handler.query(new Request("https://example.com/app"));
    const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
    assert.match(html, /class="pending-link workspace-primary"/);
    assert.match(html, /href="\/app\?view=selection"/);
    assert.doesNotMatch(html, /aria-busy|<s-spinner/, "idle links show no loading state");
  } finally {
    await server.close();
  }
});
