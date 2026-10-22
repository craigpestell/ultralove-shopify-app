import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";

test("inventory enrollment, persistent retries, pause and reservations work end-to-end without importing or repricing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ultralove-inventory-"));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${join(directory, "test.sqlite")}`;
  const server = await createServer({
    configFile: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom",
    plugins: [{
      name: "test-inventory-boundaries", enforce: "pre",
      load(id) {
        if (id.endsWith("/app/catalog.server.ts")) return `
          export class CatalogError extends Error {
            constructor(message,retryAfter=null) { super(message);this.retryAfter=retryAfter; }
          }
          export const feed = { value: null, reads: [], batches: [], hook: null, error: null, schemaVersion: "1.2", versionChecks: 0 };
          export async function categoriesPage() {
            feed.versionChecks++;
            return { categories: [], next_after_id: 0, has_more: false, schemaVersion: feed.schemaVersion };
          }
          export async function inventoryState(id, checkpoint) {
            feed.reads.push({id,checkpoint});
            if(feed.hook) await feed.hook();
            if(feed.error) throw feed.error;
            return typeof feed.value === "function" ? feed.value(id) : feed.value;
          }
          export async function inventoryStates(products) {
            feed.batches.push(products.map(product=>product.supplierId));
            return Promise.all(products.map(product=>inventoryState(product.supplierId,product.checkpoint)));
          }
          export async function validateSelection() {}
          export async function importPlan() { throw new Error("Inventory must not import"); }`;
        if (id.endsWith("/app/shopify.server.ts")) return `
          export const auth = { shop: "ultralove-integration-lab.myshopify.com", api: null, rejected: false };
          export async function authenticateLabAdmin() {
            if(auth.rejected) throw new Response("Forbidden",{status:403});
            return {session:{shop:auth.shop},admin:{graphql:async(query,options)=>({json:()=>auth.api(query,options.variables)})}};
          }`;
      },
    }],
  });
  const { default: db } = await server.ssrLoadModule("/app/db.server.ts");
  try {
    for (const migration of (await readdir(new URL("../prisma/migrations/", import.meta.url))).filter((name) => /^\d/.test(name)).sort()) {
      const sql = await readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8");
      for (const statement of sql.split(";").filter((part) => part.trim())) await db.$executeRawUnsafe(statement);
    }
    const { enableAllInventory, inventoryControl, inventoryScreen, runInventoryCycle, runInventoryBatch } = await server.ssrLoadModule("/app/inventory.server.ts");
    const { INVENTORY_QUERY, INVENTORY_BATCH_QUERY, INVENTORY_SET_MUTATION, INVENTORY_CHECKED_MUTATION } = await server.ssrLoadModule("/app/inventory-engine.ts");
    const { CONTEXT_QUERY } = await server.ssrLoadModule("/app/import-engine.ts");
    const { feed, CatalogError } = await server.ssrLoadModule("/app/catalog.server.ts");
    const { markListingDeleted } = await server.ssrLoadModule("/app/listing-lifecycle.server.ts");
    const { auth } = await server.ssrLoadModule("/app/shopify.server.ts");
    const shop = auth.shop;
    const location = "gid://shopify/Location/1";
    const generation = "00000000-0000-4000-8000-000000000001";
    const products = new Map();
    const responses = new Map();
    const mutationSizes = [];
    let mutations = 0;
    let mutationRequests = 0;
    let loseResponse = false;
    let loseBeforeMutation = false;
    let rejectMutation = false;
    let inventoryRequests = 0;
    let contextRequests = 0;
    const mutationKeys = [];
    const checkedTimes = new Map();
    const seed = async (id, sources) => {
      const run = id.toString(16).padStart(32, "0");
      const productId = `gid://shopify/Product/${id}`;
      const variantInputs = sources.map((source) => ({
        sku: `SKU-${source}`, price: "99.00", inventoryPolicy: "DENY", inventoryItem: { tracked: true },
        inventoryQuantities: [{ locationId: location, name: "available", quantity: 4 }],
        metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", value: String(source) }],
      }));
      const input = {
        title: "Supplier product", handle: `ultralove-catalog-${id}`, status: "DRAFT",
        tags: ["ultralove-catalog-import", `ultralove-catalog-run-${run}`],
        metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", value: String(id) }], variants: variantInputs,
      };
      await db.importJob.create({ data: {
        id: run, shop, status: "COMPLETE", selection: JSON.stringify([id]), markup: "0.00", locationId: location,
        generation, cursor: 8, items: { create: [{
          supplierId: id, name: "Supplier product", sku: `SKU-${id}`, wholesale: JSON.stringify(sources.map(() => "10.00")),
          payload: JSON.stringify(input), status: "CREATED", productId,
        }] },
      } });
      await db.importClaim.create({ data: { shop, supplierId: id, runId: run, productId } });
      products.set(productId, {
        id: productId, handle: input.handle, tags: input.tags, supplierId: { value: String(id) },
        title: "Retailer title", price: "99.00", description: "Retailer description", published: true,
        nodes: sources.map((source) => ({
          id: `gid://shopify/ProductVariant/${source}`, supplierId: { value: String(source) },
          inventoryItem: { id: `gid://shopify/InventoryItem/${source}`, tracked: true, onHand: 4, committed: source === 101 ? 2 : 0 },
        })),
      });
    };
    const inventoryPage = (id, after = null, pageSize = 100) => {
      const product = products.get(id);
      if (!product) return null;
      const offset = Number(after || 0);
      return { ...product, variants: {
        nodes: product.nodes.slice(offset, offset + pageSize).map((node) => ({ ...node, inventoryItem: {
          ...node.inventoryItem, inventoryLevel: { quantities: [
            { name: "on_hand", quantity: node.inventoryItem.onHand },
            { name: "committed", quantity: node.inventoryItem.committed },
          ] },
        } })),
        pageInfo: { hasNextPage: offset + pageSize < product.nodes.length, endCursor: String(offset + pageSize) },
      } };
    };
    const api = async (query, variables) => {
      if (query === CONTEXT_QUERY) {
        contextRequests++;
        return { data: {
        shop: { myshopifyDomain: shop, currencyCode: "CAD" },
        locations: { nodes: [{ id: location, name: "Shop location", isActive: true, fulfillsOnlineOrders: true }], pageInfo: { hasNextPage: false } },
        } };
      }
      if (query === INVENTORY_QUERY) {
        inventoryRequests++;
        return { data: { product: inventoryPage(variables.id, variables.after) } };
      }
      if (query === INVENTORY_BATCH_QUERY) {
        inventoryRequests++;
        assert.ok(variables.ids.length > 1 && variables.ids.length <= 5);
        return { data: { nodes: variables.ids.map((id) => inventoryPage(id, null, 25)) } };
      }
      if (query === INVENTORY_CHECKED_MUTATION) {
        assert.ok(variables.metafields.length <= 25);
        for (const field of variables.metafields) {
          assert.deepEqual([field.namespace, field.key, field.type], ["ultralove", "inventory_checked_at", "date_time"]);
          checkedTimes.set(field.ownerId, field.value);
        }
        return { data: { metafieldsSet: { userErrors: [] } } };
      }
      assert.equal(query, INVENTORY_SET_MUTATION, "no product/content/publication/order mutations are allowed");
      mutationRequests++;
      mutationKeys.push(variables.key);
      assert.equal(variables.input.name, "on_hand");
      assert.deepEqual(Object.keys(variables.input).sort(), ["name", "quantities", "reason", "referenceDocumentUri"]);
      assert.ok(variables.input.quantities.length <= 250);
      const persisted = await db.inventorySync.findFirst({ where: { pendingKey: variables.key } });
      assert.ok(persisted?.pendingAt, "persist key, input and timestamp before sending any stock mutation");
      const { participants, ...savedInput } = JSON.parse(persisted.pending);
      if (participants) {
        const rows = await db.inventorySync.findMany({ where: { pendingKey: variables.key } });
        assert.deepEqual(rows.map(row => row.supplierId).sort((a, b) => a - b), participants);
        assert.ok(rows.every(row => row.pending === persisted.pending && row.pendingAt.getTime() === persisted.pendingAt.getTime()),
          "every participating product must have the identical full correction before dispatch");
      }
      assert.deepEqual({ ...savedInput, quantities: savedInput.quantities.map(({ compareQuantity, ...quantity }) => ({
        ...quantity, changeFromQuantity: compareQuantity,
      })) }, variables.input);
      if (loseBeforeMutation) { loseBeforeMutation = false; throw new Error("Lost connection before stock correction"); }
      if (responses.has(variables.key)) {
        assert.deepEqual(responses.get(variables.key).input, variables.input, "a retry must use the exact same mutation input");
        return responses.get(variables.key).body;
      }
      if (rejectMutation) {
        rejectMutation = false;
        return { data: { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ message: "Quantity changed concurrently" }] } } };
      }
      for (const quantity of variables.input.quantities) {
        const item = [...products.values()].flatMap((product) => product.nodes).find((node) => node.inventoryItem.id === quantity.inventoryItemId).inventoryItem;
        assert.ok(!("compareQuantity" in quantity), "the deprecated comparison field must not reach Shopify");
        assert.equal(quantity.changeFromQuantity, item.onHand);
        assert.equal(quantity.locationId, location);
        item.onHand = quantity.quantity;
      }
      mutations++;
      mutationSizes.push(variables.input.quantities.length);
      const body = { data: { inventorySetQuantities: {
        inventoryAdjustmentGroup: { referenceDocumentUri: variables.input.referenceDocumentUri }, userErrors: [],
      } } };
      responses.set(variables.key, { input: structuredClone(variables.input), body });
      if (loseResponse) { loseResponse = false; throw new Error("Lost response after stock correction"); }
      return body;
    };
    auth.api = api;
    await seed(100, [101, 102]);
    const source = (id, sources, quantity = 7, cursor = 9) => ({
      generation, cursor, parent_id: id, published: true, source_ids: sources, resynced: false,
      inventory: sources.map((source) => ({ id: source, manage_stock: true, stock_quantity: quantity, stock_owner_id: source, stock_status: "instock" })),
    });
    feed.value = source(100, [101, 102]);
    assert.equal((await inventoryScreen(shop))[0].enabled, false);
    assert.equal(await db.inventorySync.count(), 0, "imports do not silently enroll products");
    await assert.rejects(inventoryControl(shop, 100, "enable", api), /Confirm/);
    await assert.rejects(inventoryControl("foreign.myshopify.com", 100, "enable", api, "inventory-only"));
    await inventoryControl(shop, 100, "enable", api, "inventory-only");
    const { lastFeedVersionCheck, BLOCKED_RECHECK_AGE } = await server.ssrLoadModule("/app/feed-version.server.ts");
    feed.schemaVersion = "2.0";
    const enrolled = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 100 } } });
    await runInventoryCycle(shop, 100, api);
    assert.deepEqual([feed.reads.length, feed.versionChecks, mutations], [0, 1, 0], "a breaking feed version pauses sync before any read or write");
    assert.deepEqual(await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 100 } } }), enrolled,
      "paused products keep their state, like the Settings pause");
    assert.deepEqual([(await lastFeedVersionCheck()).trigger, (await lastFeedVersionCheck()).result], ["inventory", "unsupported"]);
    const renderSettings = async () => {
      const settingsRoute = await server.ssrLoadModule("/app/routes/app.settings.tsx");
      const { WorkspaceProvider } = await server.ssrLoadModule("/app/workspace.tsx");
      const handler = createStaticHandler([{ id: "settings", path: "/app/settings", loader: settingsRoute.loader, Component: () =>
        createElement(WorkspaceProvider, { shop, saved: { selected: [], markup: "0", markups: {} } }, createElement(settingsRoute.default)) }]);
      const context = await handler.query(new Request("https://app.example/app/settings"));
      return renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
    };
    const settingsHtml = await renderSettings();
    for (const shown of ["Supplier feed version", "Imports and inventory sync are paused", "<dt>Feed version</dt><dd>2.0</dd>",
      "<dt>Supported versions</dt><dd>1.x (written for 1.2)</dd>", "Checked before inventory sync.", "<dt>Result</dt><dd>Not supported</dd>",
      "<dt>Paused because</dt><dd>The supplier feed uses schema 2.0", "Check feed version now"]) {
      assert.ok(settingsHtml.includes(shown), `Settings shows: ${shown}`);
    }
    feed.schemaVersion = "1.2";
    await runInventoryCycle(shop, 100, api);
    assert.deepEqual([feed.reads.length, feed.versionChecks], [0, 1], "the block is reused instead of asking the feed every cycle");
    await db.feedVersionCheck.update({ where: { id: "lab" }, data: { checkedAt: new Date(Date.now() - BLOCKED_RECHECK_AGE + 1000) } });
    const { action: settingsAction } = await server.ssrLoadModule("/app/routes/app.settings.tsx");
    const checked = await settingsAction({ request: new Request("https://app.example/app/settings", {
      method: "POST", body: new URLSearchParams([["intent", "check-feed-version"]]) }) });
    assert.equal(checked.data.checked, "compatible", "Check feed version now lifts the pause once the feed is supported again");
    const resumedHtml = await renderSettings();
    assert.ok(!resumedHtml.includes("Imports and inventory sync are paused"));
    assert.ok(resumedHtml.includes("<dt>Feed version</dt><dd>1.2</dd>") && resumedHtml.includes("Checked from Settings."));
    loseResponse = true;
    await runInventoryCycle(shop, 100, api);
    let state = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 100 } } });
    assert.equal(state.status, "FAILED");
    assert.equal(state.cursor, null);
    assert.ok(state.pendingKey);
    assert.equal(mutations, 1);
    const item = products.get("gid://shopify/Product/100").nodes[0].inventoryItem;
    assert.equal(item.onHand, 7);
    assert.equal(item.committed, 2);
    assert.equal(item.onHand - item.committed, 5);
    await db.inventorySync.update({ where: { shop_supplierId: { shop, supplierId: 100 } }, data: { status: "RUNNING", nextRunAt: new Date(0) } });
    await db.inventorySync.updateMany({ where: { shop, enabled: true, status: "RUNNING" }, data: { status: "QUEUED" } });
    await runInventoryCycle(shop, 100, api);
    state = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 100 } } });
    assert.equal(state.status, "SYNCED");
    assert.equal(state.cursor, 9);
    assert.equal(checkedTimes.get("gid://shopify/Product/100"), state.lastSuccessAt.toISOString(), "the product page gets the verified check time");
    assert.equal(state.pending, null);
    assert.equal(mutations, 1, "restart/retry does not apply an uncertain successful correction twice");
    assert.equal(mutationRequests, 1, "Shopify confirms the pending quantities without replaying an already-applied write");
    assert.deepEqual(feed.reads.at(-1).checkpoint, null, "failed cycles must not advance the checkpoint");

    await inventoryControl(shop, 100, "pause", api);
    feed.value = source(100, [101, 102], 10, 10);
    await runInventoryCycle(shop, 100, api);
    assert.equal(item.onHand, 7);
    await inventoryControl(shop, 100, "enable", api, "inventory-only");
    feed.hook = async () => inventoryControl(shop, 100, "pause", api);
    await runInventoryCycle(shop, 100, api);
    assert.equal(item.onHand, 7, "a pause during feed reads prevents reserving/sending a new mutation");
    assert.equal((await inventoryScreen(shop))[0].status, "PAUSED");
    feed.hook = null;
    await inventoryControl(shop, 100, "enable", api, "inventory-only");
    rejectMutation = true;
    await runInventoryCycle(shop, 100, api);
    state = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 100 } } });
    assert.match(state.error, /concurrently/);
    assert.equal(state.cursor, 9);
    assert.equal(state.pending, null, "a confirmed rejection can start a fresh compare-and-set on the next cycle");
    await inventoryControl(shop, 100, "sync-now", api);
    await runInventoryCycle(shop, 100, api);
    assert.equal(item.onHand, 10);
    assert.equal(item.committed, 2);
    feed.value = { ...source(100, [], 0, 11), published: false };
    await inventoryControl(shop, 100, "sync-now", api);
    await runInventoryCycle(shop, 100, api);
    assert.equal(item.onHand, 0);
    state = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 100 } } });
    assert.equal(state.status, "REVIEW");
    assert.match(state.error, /withdrawn/);
    const remote = products.get("gid://shopify/Product/100");
    assert.deepEqual([remote.title, remote.price, remote.description, remote.published], ["Retailer title", "99.00", "Retailer description", true]);
    assert.equal(await db.importJob.count(), 1);

    feed.value = source(100, [101, 102], 12, 12);
    await inventoryControl(shop, 100, "sync-now", api);
    loseResponse = true;
    await runInventoryCycle(shop, 100, api);
    await db.inventorySync.update({ where: { shop_supplierId: { shop, supplierId: 100 } },
      data: { pendingAt: new Date(Date.now() - 25 * 60 * 60 * 1000), nextRunAt: new Date(0) } });
    const beforeExpiry = mutationRequests;
    await runInventoryCycle(shop, 100, api);
    state = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 100 } } });
    assert.equal(state.enabled, false);
    assert.match(state.error, /24-hour/);
    assert.equal(mutationRequests, beforeExpiry, "expired uncertain keys are never automatically replayed");
    await inventoryControl(shop, 100, "enable", api, "inventory-only");
    await runInventoryCycle(shop, 100, api);
    assert.equal((await inventoryScreen(shop))[0].status, "SYNCED");

    await seed(200, Array.from({ length: 251 }, (_, i) => i + 201));
    feed.value = source(200, Array.from({ length: 251 }, (_, i) => i + 201));
    await inventoryControl(shop, 200, "enable", api, "inventory-only");
    const beforeBulk = mutationSizes.length;
    await runInventoryCycle(shop, 200, api);
    assert.deepEqual(mutationSizes.slice(beforeBulk), [250, 1], "251 variants are corrected in valid bounded mutation batches");
    assert.equal((await inventoryScreen(shop)).find((product) => product.supplierId === 200).variantCount, 251);
    feed.error = new CatalogError("Supplier rate limit: retry after 3600 seconds.", 3600);
    await inventoryControl(shop, 200, "sync-now", api);
    const rateLimitedAt = Date.now();
    const beforeRateLimit = mutationRequests;
    await runInventoryCycle(shop, 200, api);
    const limited = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 200 } } });
    assert.match(limited.error, /3600/);
    assert.ok(limited.nextRunAt.getTime() >= rateLimitedAt + 3600 * 1000, "the persisted scheduler respects supplier Retry-After");
    assert.equal(mutationRequests, beforeRateLimit);
    feed.error = null;
    const { action, loader, default: Inventory } = await server.ssrLoadModule("/app/routes/app.inventory.tsx");
    const result = await action({ request: new Request("https://app.example/app/inventory", {
      method: "POST", body: new URLSearchParams([["supplierId", "100"], ["supplierId", "200"], ["intent", "pause"]]),
    }) });
    assert.equal(result.init.status, 400);
    const hugeId = await action({ request: new Request("https://app.example/app/inventory", {
      method: "POST", body: new URLSearchParams([["supplierId", "999999999999999999999"], ["intent", "enable"], ["confirm", "inventory-only"]]),
    }) });
    assert.equal(hugeId.init.status, 400);
    await inventoryControl(shop, 100, "pause", api);
    const { WorkspaceProvider } = await server.ssrLoadModule("/app/workspace.tsx");
    const handler = createStaticHandler([{ id: "inventory", path: "/app/inventory", loader, Component: () =>
      createElement(WorkspaceProvider, { shop, saved: { selected: [], markup: "0", markups: {} } }, createElement(Inventory)) }]);
    const context = await handler.query(new Request("https://app.example/app/inventory"));
    const router = createStaticRouter(handler.dataRoutes, context);
    const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router, context }));
    assert.match(html, /Pause sync/);
    assert.match(html, /Enable inventory sync/);
    assert.match(html, /name="confirm"/);
    assert.match(html, /required/);
    assert.match(html, /Sync now/);
    assert.match(html, /Shopify order reservations remain in place/);
    assert.match(html, /251 mapped variants/);
    await seed(400, [601]);
    feed.value = source(400, [601]);
    await inventoryControl(shop, 400, "enable", api, "inventory-only");
    loseBeforeMutation = true;
    await runInventoryCycle(shop, 400, api);
    const unsent = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 400 } } });
    assert.ok(unsent.pendingKey);
    assert.equal(products.get("gid://shopify/Product/400").nodes[0].inventoryItem.onHand, 4);
    await inventoryControl(shop, 400, "sync-now", api);
    await runInventoryCycle(shop, 400, api);
    assert.equal((await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 400 } } })).status, "SYNCED");
    assert.deepEqual(mutationKeys.slice(-2), [unsent.pendingKey, unsent.pendingKey],
      "unconfirmed quantities still retry the exact persisted correction key and input");
    await seed(300, [501]);
    feed.value = source(300, [501]);
    await inventoryControl(shop, 300, "enable", api, "inventory-only");
    loseResponse = true;
    await runInventoryCycle(shop, 300, api);
    const missingBefore = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 300 } } });
    assert.ok(missingBefore.pendingKey);
    const missingProduct = products.get("gid://shopify/Product/300");
    products.delete("gid://shopify/Product/300");
    const beforeMissing = { requests: mutationRequests, feed: feed.reads.length };
    await inventoryControl(shop, 300, "sync-now", api);
    await runInventoryCycle(shop, 300, api);
    const missingAfter = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 300 } } });
    assert.equal(missingAfter.enabled, false);
    assert.equal(missingAfter.status, "REVIEW");
    assert.match(missingAfter.error, /linked Shopify product could not be found/);
    for (const field of ["productId", "mappings", "generation", "cursor", "pending", "pendingKey"]) {
      assert.equal(missingAfter[field], missingBefore[field], `missing products preserve ${field}`);
    }
    assert.deepEqual(missingAfter.pendingAt, missingBefore.pendingAt);
    await runInventoryCycle(shop, 300, api);
    assert.equal(mutationRequests, beforeMissing.requests, "missing products never send or replay stock writes");
    assert.equal(feed.reads.length, beforeMissing.feed, "missing products stop before fetching new supplier stock");
    await assert.rejects(inventoryControl(shop, 300, "sync-now", api), /paused/);
    await assert.rejects(inventoryControl(shop, 300, "enable", api, "inventory-only"), /could not be found/);
    products.set("gid://shopify/Product/300", missingProduct);
    await runInventoryCycle(shop, 300, api);
    assert.equal(mutationRequests, beforeMissing.requests, "a returned listing does not silently re-enable sync");
    await inventoryControl(shop, 300, "enable", api, "inventory-only");
    await runInventoryCycle(shop, 300, api);
    const recovered = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 300 } } });
    assert.equal(recovered.status, "SYNCED");
    assert.equal(recovered.pendingKey, null);
    assert.equal(mutationRequests, beforeMissing.requests, "explicit recovery verifies already-applied quantities without resending");
    assert.equal(mutations, mutationSizes.length, "idempotent recovery does not apply a correction twice");

    for (const id of [1000, 1100, 1200, 1300, 1400]) await seed(id, [id * 10 + 1]);
    for (const id of [1000, 1100, 1200, 1400]) await inventoryControl(shop, id, "enable", api, "inventory-only");
    await inventoryControl(shop, 1000, "pause", api);
    await inventoryControl(shop, 1200, "pause", api);
    await db.inventorySync.update({ where: { shop_supplierId: { shop, supplierId: 1200 } }, data: { status: "RUNNING" } });
    products.delete("gid://shopify/Product/1300");
    feed.value = source(1400, [14001], 7, 20);
    loseBeforeMutation = true;
    await runInventoryCycle(shop, 1400, api);
    await inventoryControl(shop, 1400, "pause", api);
    const protectedBefore = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 1400 } } });
    const enabledBefore = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 1100 } } });
    await assert.rejects(enableAllInventory(shop, api, "inventory-only"), /Confirm/);
    for (let id = 1500; id < 1800; id++) await seed(id, [id * 10 + 1]);
    const candidates = (await inventoryScreen(shop)).filter(product => !product.enabled && product.status !== "RUNNING");
    const bulkBefore = { reads: inventoryRequests, contexts: contextRequests, mutations: mutationRequests };
    const bulkAction = await action({ request: new Request("https://app.example/app/inventory?search=SKU-1500&filter=off", {
      method: "POST", body: new URLSearchParams({ intent: "enable-all", confirm: "inventory-all-current" }),
    }) });
    const bulk = bulkAction.data.bulk;
    assert.equal(bulk.enabled, 302, "all 300 new imports and both safe paused products enroll independently of visible search results");
    assert.deepEqual(bulk.blocked.map(product => product.supplierId).sort((a, b) => a - b), [1200, 1300, 1400]);
    assert.match(bulk.blocked.find(product => product.supplierId === 1400).error, /pending stock correction/i);
    assert.equal(bulk.total, bulk.enabled + bulk.alreadyEnabled + bulk.blocked.length);
    assert.equal(inventoryRequests - bulkBefore.reads, Math.ceil(candidates.length / 5), "bulk eligibility really batches Shopify reads across products");
    assert.equal(contextRequests - bulkBefore.contexts, 1, "bulk enrollment shares a single approved shop/location lookup");
    assert.equal(mutationRequests, bulkBefore.mutations, "enrollment schedules stock cycles without mutating stock");
    const protectedAfter = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 1400 } } });
    assert.deepEqual(protectedAfter, protectedBefore, "bulk enable never resumes or resets a protected uncertain correction");
    assert.deepEqual(await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 1100 } } }), enabledBefore,
      "already-enabled products keep their exact revision, checkpoint and schedule");
    await seed(1800, [18001]);
    assert.equal(await db.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId: 1800 } } }), null,
      "future imports remain opt-in");
    for (const body of [
      { intent: "enable-all" }, { intent: "enable-all", confirm: "inventory-only" },
      { intent: "enable-all", confirm: "inventory-all-current", supplierId: "1500" },
    ]) {
      const rejected = await action({ request: new Request("https://app.example/app/inventory", {
        method: "POST", body: new URLSearchParams(body),
      }) });
      assert.equal(rejected.init.status, 400);
    }

    const crossIds = [1900, 1901, 1902, 1903, 1904];
    for (const id of crossIds) {
      await seed(id, [id * 10 + 1]);
      await inventoryControl(shop, id, "enable", api, "inventory-only");
    }
    products.get("gid://shopify/Product/1900").nodes[0].inventoryItem.committed = 3;
    let desired = 11;
    let cursor = 21;
    feed.value = id => source(id, [id * 10 + 1], desired, cursor);
    const syncCross = async () => {
      for (const id of crossIds) await inventoryControl(shop, id, "sync-now", api);
    };
    const crossBefore = { contexts: contextRequests, reads: inventoryRequests, feed: feed.batches.length, sizes: mutationSizes.length };
    await runInventoryBatch(shop, crossIds, api);
    assert.equal(contextRequests - crossBefore.contexts, 1);
    assert.equal(inventoryRequests - crossBefore.reads, 2, "five simple products need one initial and one final shared Shopify inventory read");
    assert.equal(feed.batches.length - crossBefore.feed, 1);
    assert.deepEqual(feed.batches.at(-1), crossIds);
    assert.deepEqual(mutationSizes.slice(crossBefore.sizes), [5], "five products share one real stock mutation");
    for (const id of crossIds) {
      const state = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: id } } });
      assert.equal(state.status, "SYNCED");
      assert.equal(state.cursor, cursor);
      assert.equal(state.pending, null);
      const product = products.get(`gid://shopify/Product/${id}`);
      assert.equal(product.nodes[0].inventoryItem.onHand, desired);
      assert.deepEqual([product.title, product.price, product.description, product.published], ["Retailer title", "99.00", "Retailer description", true]);
    }
    assert.equal(products.get("gid://shopify/Product/1900").nodes[0].inventoryItem.committed, 3);
    await syncCross();
    const unchanged = mutationRequests;
    await runInventoryBatch(shop, crossIds, api);
    assert.equal(mutationRequests, unchanged, "unchanged batched inventory never sends a mutation");

    desired = 12; cursor = 22;
    await syncCross();
    loseBeforeMutation = true;
    await runInventoryBatch(shop, crossIds, api);
    const uncertain = await db.inventorySync.findMany({ where: { shop, supplierId: { in: crossIds } }, orderBy: { supplierId: "asc" } });
    assert.ok(uncertain[0].pendingKey);
    assert.ok(uncertain.every(state => state.pending === uncertain[0].pending && state.pendingKey === uncertain[0].pendingKey && state.cursor === 21));
    assert.deepEqual(JSON.parse(uncertain[0].pending).participants, crossIds);
    await db.inventorySync.updateMany({ where: { shop, supplierId: { in: crossIds } }, data: { status: "RUNNING" } });
    await db.inventorySync.updateMany({ where: { shop, enabled: true, status: "RUNNING" }, data: { status: "QUEUED" } });
    await inventoryControl(shop, 1900, "sync-now", api);
    await runInventoryCycle(shop, 1900, api);
    assert.deepEqual(mutationKeys.slice(-2), [uncertain[0].pendingKey, uncertain[0].pendingKey],
      "single-product scheduling after restart expands the original group and replays its exact full input/key");
    assert.equal((await db.inventorySync.findMany({ where: { shop, supplierId: { in: crossIds }, pendingKey: { not: null } } })).length, 0);

    desired = 13; cursor = 23;
    await syncCross();
    loseResponse = true;
    await runInventoryBatch(shop, crossIds, api);
    await inventoryControl(shop, 1901, "pause", api);
    await inventoryControl(shop, 1900, "sync-now", api);
    const acknowledged = mutationRequests;
    await runInventoryCycle(shop, 1900, api);
    assert.equal(mutationRequests, acknowledged, "an already-applied cross-product correction is reconciled without any replay, even when a participant is paused");
    assert.equal((await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 1901 } } })).status, "PAUSED");
    assert.equal(await db.inventorySync.count({ where: { shop, supplierId: { in: crossIds }, pendingKey: { not: null } } }), 0);

    await inventoryControl(shop, 1901, "enable", api, "inventory-only");
    desired = 14; cursor = 24;
    await syncCross();
    loseBeforeMutation = true;
    await runInventoryBatch(shop, crossIds, api);
    const pausedPending = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 1900 } } });
    await inventoryControl(shop, 1902, "pause", api);
    await inventoryControl(shop, 1900, "sync-now", api);
    const pausedRequests = mutationRequests;
    await runInventoryCycle(shop, 1900, api);
    assert.equal(mutationRequests, pausedRequests, "pausing any participant prevents replay of a shared unconfirmed mutation");
    assert.equal(await db.inventorySync.count({ where: { shop, pendingKey: pausedPending.pendingKey } }), 5);
    const pausedBulk = await enableAllInventory(shop, api, "inventory-all-current");
    assert.ok(pausedBulk.blocked.some(product => product.supplierId === 1902 && /pending stock correction/.test(product.error)));
    await inventoryControl(shop, 1902, "enable", api, "inventory-only");
    await inventoryControl(shop, 1900, "sync-now", api);
    await runInventoryCycle(shop, 1900, api);
    assert.equal(mutationKeys.at(-1), pausedPending.pendingKey);
    assert.equal(await db.inventorySync.count({ where: { shop, pendingKey: pausedPending.pendingKey } }), 0);

    desired = 15; cursor = 25;
    await syncCross();
    rejectMutation = true;
    await runInventoryBatch(shop, crossIds, api);
    assert.equal(await db.inventorySync.count({ where: { shop, supplierId: { in: crossIds }, pendingKey: { not: null } } }), 0);
    for (const id of crossIds) {
      const state = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: id } } });
      assert.equal(state.cursor, 24, "a rejected shared correction never advances any participant checkpoint");
      assert.match(state.error, /concurrently/);
    }
    desired = 16; cursor = 26;
    await syncCross();
    const crossMissingProduct = products.get("gid://shopify/Product/1904");
    products.delete("gid://shopify/Product/1904");
    const missingCross = mutationSizes.length;
    await runInventoryBatch(shop, crossIds, api);
    assert.deepEqual(mutationSizes.slice(missingCross), [4], "a missing listing is paused while healthy products in the batch still synchronize");
    const missingCrossState = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 1904 } } });
    assert.equal(missingCrossState.enabled, false);
    assert.equal(missingCrossState.status, "REVIEW");
    products.set("gid://shopify/Product/1904", crossMissingProduct);
    await inventoryControl(shop, 1904, "enable", api, "inventory-only");
    desired = 17; cursor = 27;
    feed.value = id => ({ ...source(id, [id * 10 + 1], desired, cursor), ...(id === 1903 ? { cursor: -1 } : {}) });
    await syncCross();
    const malformedBefore = mutationSizes.length;
    await runInventoryBatch(shop, crossIds, api);
    assert.deepEqual(mutationSizes.slice(malformedBefore), [4], "invalid per-product supplier data never becomes zero stock and does not block healthy siblings");
    assert.equal(products.get("gid://shopify/Product/1903").nodes[0].inventoryItem.onHand, 16);
    assert.equal((await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 1903 } } })).cursor, 26);
    desired = 18; cursor = 28;
    feed.value = id => source(id, [id * 10 + 1], desired, cursor);
    await syncCross();
    let pauseDuringRead = false;
    feed.hook = async () => {
      if (pauseDuringRead) return;
      pauseDuringRead = true;
      await inventoryControl(shop, 1900, "pause", api);
    };
    const pauseBefore = mutationSizes.length;
    await runInventoryBatch(shop, crossIds, api);
    feed.hook = null;
    assert.deepEqual(mutationSizes.slice(pauseBefore), [4], "a pause before batch reservation excludes that product while healthy products continue");
    assert.equal(products.get("gid://shopify/Product/1900").nodes[0].inventoryItem.onHand, 17);
    assert.equal((await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 1900 } } })).pending, null);
    await inventoryControl(shop, 1900, "enable", api, "inventory-only");

    const largeIds = [2100, 2200, 2300, 2400, 2500];
    const sources = new Map(largeIds.map((id, index) => [id, Array.from({ length: index === 0 ? 200 : index === 1 ? 100 : 1 }, (_, offset) => id * 10 + offset + 1)]));
    for (const id of largeIds) {
      await seed(id, sources.get(id));
      await inventoryControl(shop, id, "enable", api, "inventory-only");
    }
    feed.value = id => source(id, sources.get(id), 17, 27);
    const largeBefore = mutationSizes.length;
    await runInventoryBatch(shop, largeIds, api);
    assert.deepEqual(mutationSizes.slice(largeBefore), [250, 53], "303 quantities from five products share bounded 250/53 cross-product writes");
    assert.equal(await db.inventorySync.count({ where: { shop, supplierId: { in: largeIds }, status: "SYNCED", cursor: 27 } }), 5);

    for (let id = 2600; id < 2610; id++) await seed(id, [id * 10 + 1]);
    let bulkRequests = 0;
    const partial = await enableAllInventory(shop, async (query, variables) => {
      if (query === INVENTORY_BATCH_QUERY && ++bulkRequests === 2) throw new Error("Injected Shopify connection interruption");
      return api(query, variables);
    }, "inventory-all-current");
    assert.ok(partial.error);
    assert.equal(partial.enabled, 4, "completed enrollment remains truthful when a later validation batch loses its connection; archived products do not consume batch slots");
    assert.equal(partial.total, partial.enabled + partial.alreadyEnabled + partial.blocked.length);
    assert.ok(partial.blocked.filter(product => product.supplierId >= 2604).every(product => /Not enabled:/.test(product.error)));
    assert.equal(await db.inventorySync.count({ where: { shop, supplierId: { gte: 2600, lt: 2610 }, enabled: true } }), 4);

    desired = 19; cursor = 29;
    feed.value = id => source(id, [id * 10 + 1], desired, cursor);
    await syncCross();
    loseBeforeMutation = true;
    await runInventoryBatch(shop, crossIds, api);
    const expiredCorrection = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 1900 } } });
    const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.inventorySync.updateMany({ where: { shop, pendingKey: expiredCorrection.pendingKey },
      data: { pendingAt: expiredAt, nextRunAt: new Date(0) } });
    const expiredRequests = mutationRequests;
    await runInventoryCycle(shop, 1900, api);
    assert.equal(mutationRequests, expiredRequests, "an expired shared key is never replayed or silently reconciled away");
    const expiredStates = await db.inventorySync.findMany({ where: { shop, pendingKey: expiredCorrection.pendingKey } });
    assert.equal(expiredStates.length, 5);
    assert.ok(expiredStates.every(state => !state.enabled && state.status === "REVIEW" && /24-hour/.test(state.error)));
    await assert.rejects(inventoryControl(shop, 1900, "enable", api, "inventory-only"), /expired cross-product/);
    assert.equal(await db.inventorySync.count({ where: { shop, pendingKey: expiredCorrection.pendingKey } }), 5);
    await db.inventorySync.update({ where: { shop_supplierId: { shop, supplierId: 1904 } }, data: { pending: null, pendingKey: null, pendingAt: null } });
    await db.inventorySync.update({ where: { shop_supplierId: { shop, supplierId: 1900 } },
      data: { enabled: true, status: "QUEUED", nextRunAt: new Date(0) } });
    await runInventoryCycle(shop, 1900, api);
    assert.equal(mutationRequests, expiredRequests, "an incomplete shared ledger cannot be replayed with a changed subset");
    assert.match((await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 1900 } } })).error, /incomplete or inconsistent/);
    await seed(2900, [2901]);
    await db.importClaim.update({ where: { shop_supplierId: { shop, supplierId: 2900 } }, data: { fulfillmentMode: "CATALOG" } });
    const catalogBaseline = { contextRequests, inventoryRequests, mutationRequests };
    await assert.rejects(inventoryControl(shop, 2900, "enable", api, "inventory-only"), /retailer-managed/);
    await assert.rejects(inventoryControl(shop, 2900, "sync-now", api), /retailer-managed/);
    assert.deepEqual({ contextRequests, inventoryRequests, mutationRequests }, catalogBaseline, "catalog-only requests never reach Shopify inventory");
    const mixedEnrollment = await enableAllInventory(shop, api, "inventory-all-current");
    assert.ok(mixedEnrollment.blocked.some((product) => product.supplierId === 2900 && /own stock/.test(product.error)));
    assert.equal(await db.inventorySync.count({ where: { shop, supplierId: 2900 } }), 0, "enable-all cannot enroll catalog-only products");
    await db.inventorySync.create({ data: {
      shop, supplierId: 2900, productId: "gid://shopify/Product/2900", locationId: location,
      mappings: JSON.stringify([{ sourceId: 2901, variantId: "gid://shopify/ProductVariant/2901", inventoryItemId: "gid://shopify/InventoryItem/2901" }]),
      enabled: true, status: "QUEUED", nextRunAt: new Date(0),
    } });
    const requestsBeforeCatalogCycle = mutationRequests;
    await runInventoryCycle(shop, 2900, api);
    assert.equal(mutationRequests, requestsBeforeCatalogCycle, "a stale enabled state cannot overwrite retailer-managed stock");
    const catalogSync = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 2900 } } });
    assert.equal(catalogSync.enabled, false);
    assert.equal(catalogSync.status, "REVIEW");
    assert.match(catalogSync.error, /fulfillment mode/);
    for (const id of [3000, 3100]) {
      await seed(id, [id + 1]);
      await inventoryControl(shop, id, "enable", api, "inventory-only");
    }
    feed.value = id => source(id, [id + 1], 20, 30);
    let deletedDuringRead = false;
    feed.hook = async () => {
      if (deletedDuringRead) return;
      deletedDuringRead = true;
      products.delete("gid://shopify/Product/3000");
      await markListingDeleted(shop, "gid://shopify/Product/3000");
    };
    const beforeConcurrentDeletion = mutationSizes.length;
    await runInventoryBatch(shop, [3000, 3100], api);
    feed.hook = null;
    assert.deepEqual(mutationSizes.slice(beforeConcurrentDeletion), [1],
      "deletion during a running batch excludes that listing without stopping healthy products");
    const stopped = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 3000 } } });
    assert.equal(stopped.enabled, false);
    assert.equal(stopped.pending, null, "no stock correction is reserved after deletion");
    assert.equal((await inventoryScreen(shop)).find(product => product.supplierId === 3000).status, "DELETED");
    auth.rejected = true;
    await assert.rejects(loader({ request: new Request("https://app.example/app/inventory") }), (error) => error.status === 403);
  } finally {
    await db.$disconnect();
    await server.close();
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
