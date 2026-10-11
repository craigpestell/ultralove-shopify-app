import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";

test("workspace restores multi-page drafts, preserves unfinished edits and stores only browse context", async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom" });
  try {
    const { restoreDraft, selectedPage, SELECTION_PAGE_SIZE, signature, validPricing, validListingChoices, listingInput, statusLabel, workspaceHref } = await server.ssrLoadModule("/app/workspace-policy.ts");
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
    assert.equal(restored.listingPolicy.mode, "KEEP", "old browser drafts default to keeping existing listings");
    assert.equal(restored.selectionSearch, "");
    assert.equal(restored.selectionPage, 1);
    assert.equal(restoreDraft({ ...draft, selectionSearch: "Amber", selectionPage: 3 }, saved).selectionPage, 3);
    for (const selectionPage of [0, -1, 1.5, "2"]) assert.equal(restoreDraft({ ...draft, selectionPage }, saved), null);
    assert.equal(restoreDraft({ ...draft, selectionSearch: "a".repeat(101) }, saved), null);
    const ids = Array.from({ length: 303 }, (_, i) => i + 1);
    const products = { 301: { id: 301, name: "Rose <strong>Kit</strong> &amp; Case", sku: "Special-XYZ", price: "12.50", type: "simple" } };
    assert.equal(SELECTION_PAGE_SIZE, 25);
    assert.deepEqual(selectedPage(ids, products, "", 1).ids, ids.slice(0, 25));
    assert.deepEqual(selectedPage(ids, products, "", 13).ids, [301, 302, 303]);
    assert.deepEqual(selectedPage(ids.slice(0, 300), products, "", 13).ids, ids.slice(275, 300), "removing the final page clamps to the previous page");
    assert.equal(selectedPage(ids, products, "", 13).start, 301);
    assert.equal(selectedPage(ids, products, "", 13).end, 303);
    for (const search of [" ROSE ", "kit & case", "special-xyz", "#301"]) {
      const filtered = selectedPage(ids, products, search, 13);
      assert.deepEqual(filtered.ids, [301], "search finds an off-page product by decoded name, SKU or ID");
      assert.equal(filtered.page, 1);
      assert.equal(filtered.total, 1);
    }
    assert.equal(selectedPage(ids, products, "302", 1).ids.includes(302), true, "IDs remain searchable without cached details");
    assert.deepEqual(selectedPage(ids, products, "not found", 13), { ids: [], total: 0, page: 1, pages: 1, start: 0, end: 0 });
    assert.equal(selectedPage(ids, products, "", 1).total, 303, "clearing a filter retains the complete selection");
    const policy = { mode: "UPDATE", content: false, images: false, prices: true, links: {}, recreate: [] };
    assert.deepEqual(restoreDraft({ ...draft, listingPolicy: policy }, saved).listingPolicy, policy);
    assert.equal(validListingChoices({ ...restored, listingPolicy: policy }), true);
    assert.equal(validListingChoices({ ...restored, listingPolicy: { ...policy, prices: false } }), false);
    assert.equal(restoreDraft({ ...draft, listingPolicy: { ...policy, mode: "invalid" } }, saved), null);
    assert.deepEqual(listingInput({ ...policy, links: { 100: "123" } }, [100]).links, { 100: "gid://shopify/Product/123" });
    assert.equal(validPricing(restored), false);
    assert.equal(validPricing({ ...restored, markup: "30.00" }), true);
    for (const markup of ["-1", "1001", "2.345", "1e2"]) assert.equal(validPricing({ ...restored, markup }), false);
    assert.equal(restoreDraft(draft, { ...saved, markup: "45" }), null, "external saved changes invalidate stale draft");
    assert.equal(restoreDraft({ ...draft, selected: Array.from({ length: 125 }, (_, i) => i + 1), markups: {} }, saved).selected.length, 125);
    assert.equal(restoreDraft({ ...draft, markups: { 300: "30" } }, saved), null);
    assert.equal(restoreDraft(null, saved), null);
    assert.equal(statusLabel("NOT_ENROLLED"), "Sync off");
    assert.equal(statusLabel("REUSED"), "Existing listing kept");
    assert.equal(statusLabel("UPDATED"), "Updated from UltraLove");
    assert.equal(statusLabel("LINKED"), "Existing listing connected");
    const inventory = workspaceHref("?host=embedded&shop=lab&search=old&job=old", "inventory", restored.browse);
    assert.equal(inventory, "/app/inventory?host=embedded&shop=lab&view=inventory");
    assert.equal(workspaceHref("?host=embedded&shop=lab", "catalog", restored.browse),
      "/app?host=embedded&shop=lab&search=Amber&after_id=100&view=catalog");
    assert.equal(workspaceHref("?host=embedded", "imports", "", "abc"), "/app?host=embedded&view=imports&job=abc");
  } finally { await server.close(); }
});
