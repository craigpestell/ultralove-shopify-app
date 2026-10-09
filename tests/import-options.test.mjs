import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("import switches default off, disable publication until Active, and restore the saved choices", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom" });
  try {
    const { default: ImportOptions } = await server.ssrLoadModule("/app/import-options.tsx");
    const defaults = renderToStaticMarkup(createElement(ImportOptions));
    assert.equal((defaults.match(/role="switch"/g) || []).length, 2);
    assert.doesNotMatch(defaults, /checked=""/);
    assert.match(defaults.match(/<input[^>]*name="publish"[^>]*>/)[0], /disabled=""/);
    assert.match(defaults, /Existing products are never activated or published/);
    const active = renderToStaticMarkup(createElement(ImportOptions, { active: true }));
    assert.match(active, /name="active"[^>]*checked=""/);
    assert.doesNotMatch(active, /disabled=""/);
    assert.doesNotMatch(active, /name="publish"[^>]*checked=""/);
    const published = renderToStaticMarkup(createElement(ImportOptions, { active: true, publish: true }));
    assert.match(published, /name="active"[^>]*checked=""/);
    assert.match(published, /name="publish"[^>]*checked=""/);
  } finally {
    await server.close();
  }
});
