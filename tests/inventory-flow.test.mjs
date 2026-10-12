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
          export const feed = { value: null, reads: [], hook: null, error: null };
          export async function inventoryState(id, checkpoint) {
            feed.reads.push({id,checkpoint});
            if(feed.hook) await feed.hook();
            if(feed.error) throw feed.error;
            return typeof feed.value === "function" ? feed.value(id) : feed.value;
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
    const { inventoryControl, inventoryScreen, runInventoryCycle } = await server.ssrLoadModule("/app/inventory.server.ts");
    const { INVENTORY_QUERY, INVENTORY_SET_MUTATION } = await server.ssrLoadModule("/app/inventory-engine.ts");
    const { CONTEXT_QUERY } = await server.ssrLoadModule("/app/import-engine.ts");
    const { feed, CatalogError } = await server.ssrLoadModule("/app/catalog.server.ts");
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
    const mutationKeys = [];
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
    const api = async (query, variables) => {
      if (query === CONTEXT_QUERY) return { data: {
        shop: { myshopifyDomain: shop, currencyCode: "CAD" },
        locations: { nodes: [{ id: location, name: "Shop location", isActive: true, fulfillsOnlineOrders: true }], pageInfo: { hasNextPage: false } },
      } };
      if (query === INVENTORY_QUERY) {
        const product = products.get(variables.id);
        if (!product) return { data: { product: null } };
        const offset = Number(variables.after || 0);
        return { data: { product: { ...product, variants: {
          nodes: product.nodes.slice(offset, offset + 100).map((node) => ({ ...node, inventoryItem: {
            ...node.inventoryItem, inventoryLevel: { quantities: [
              { name: "on_hand", quantity: node.inventoryItem.onHand },
              { name: "committed", quantity: node.inventoryItem.committed },
            ] },
          } })),
          pageInfo: { hasNextPage: offset + 100 < product.nodes.length, endCursor: String(offset + 100) },
        } } } };
      }
      assert.equal(query, INVENTORY_SET_MUTATION, "no product/content/publication/order mutations are allowed");
      mutationRequests++;
      mutationKeys.push(variables.key);
      assert.equal(variables.input.name, "on_hand");
      assert.deepEqual(Object.keys(variables.input).sort(), ["name", "quantities", "reason", "referenceDocumentUri"]);
      assert.ok(variables.input.quantities.length <= 250);
      const persisted = await db.inventorySync.findFirst({ where: { pendingKey: variables.key } });
      assert.ok(persisted?.pendingAt, "persist key, input and timestamp before sending any stock mutation");
      const savedInput = JSON.parse(persisted.pending);
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
    auth.rejected = true;
    await assert.rejects(loader({ request: new Request("https://app.example/app/inventory") }), (error) => error.status === 403);
  } finally {
    await db.$disconnect();
    await server.close();
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
