import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";

test("workspace restores bounded drafts, preserves unfinished edits and stores only browse context", async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom" });
  try {
    const { restoreDraft, signature, validPricing, statusLabel, workspaceHref } = await server.ssrLoadModule("/app/workspace-policy.ts");
    const saved = { selected: [100], markup: "25", markups: {} };
    const draft = { ...saved, selected: [100, 200], markup: "30.", markups: { 200: "50.00" },
      baseline: signature(saved), products: { 100: { id: 100, name: "Amber case", sku: "A", price: "12.50", type: "simple" } },
      browse: "search=Amber&after_id=100&host=do-not-store&id_token=do-not-store", active: false, publish: true };
    const restored = restoreDraft(draft, saved);
    assert.deepEqual(restored.selected, [100, 200]);
    assert.equal(restored.products[100].name, "Amber case");
    assert.equal(restored.markup, "30.");
    assert.deepEqual(restored.markups, { 200: "50.00" });
    assert.equal(restored.browse, "search=Amber&after_id=100");
    assert.equal(restored.publish, false);
    assert.equal(validPricing(restored), false);
    assert.equal(validPricing({ ...restored, markup: "30.00" }), true);
    for (const markup of ["-1", "1001", "2.345", "1e2"]) assert.equal(validPricing({ ...restored, markup }), false);
    assert.equal(restoreDraft(draft, { ...saved, markup: "45" }), null, "external saved changes invalidate stale draft");
    assert.equal(restoreDraft({ ...draft, selected: Array.from({ length: 51 }, (_, i) => i + 1) }, saved), null);
    assert.equal(restoreDraft({ ...draft, markups: { 300: "30" } }, saved), null);
    assert.equal(restoreDraft(null, saved), null);
    assert.equal(statusLabel("NOT_ENROLLED"), "Sync off");
    assert.equal(statusLabel("REUSED"), "Existing listing kept");
    const inventory = workspaceHref("?host=embedded&shop=lab&search=old&job=old", "inventory", restored.browse);
    assert.equal(inventory, "/app/inventory?host=embedded&shop=lab&view=inventory");
    assert.equal(workspaceHref("?host=embedded&shop=lab", "catalog", restored.browse),
      "/app?host=embedded&shop=lab&search=Amber&after_id=100&view=catalog");
    assert.equal(workspaceHref("?host=embedded", "imports", "", "abc"), "/app?host=embedded&view=imports&job=abc");
  } finally { await server.close(); }
});
