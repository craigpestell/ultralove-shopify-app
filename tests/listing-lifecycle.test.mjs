import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { createServer } from "vite";

test("deleted listings are retained, stopped, archived and explicitly recoverable across all fulfillment modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ultralove-lifecycle-"));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${join(directory, "test.sqlite")}`;
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom",
    plugins: [{ name: "lifecycle-auth-fixture", enforce: "pre", load(id) {
      if (id.endsWith("/app/shopify.server.ts")) return `
        export const auth = { shop: "ultralove-integration-lab.myshopify.com", payload: {id:100}, topic:"PRODUCTS_DELETE", rejected:false };
        export const authenticate = {webhook:async()=>{if(auth.rejected)throw new Response("Unauthorized",{status:401});return auth;}};
        export async function authenticateLabAdmin(){return {session:{shop:auth.shop}};}
      `;
    } }],
  });
  const { default: db } = await server.ssrLoadModule("/app/db.server.ts");
  try {
    for (const migration of (await readdir(new URL("../prisma/migrations/", import.meta.url))).filter(name => /^\d/.test(name)).sort()) {
      const sql = await readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8");
      for (const statement of sql.split(";").filter(part => part.trim())) await db.$executeRawUnsafe(statement);
    }
    const { markListingDeleted, verifyImportedListings, deletedProductId, LISTING_EXISTENCE_QUERY, LISTING_CHECK_INTERVAL } =
      await server.ssrLoadModule("/app/listing-lifecycle.server.ts");
    const { inventoryScreen, enableAllInventory, inventoryControl } = await server.ssrLoadModule("/app/inventory.server.ts");
    const { loader, default: Inventory } = await server.ssrLoadModule("/app/routes/app.inventory.tsx");
    const { action: webhook } = await server.ssrLoadModule("/app/routes/webhooks.products.delete.tsx");
    const { WorkspaceProvider } = await server.ssrLoadModule("/app/workspace.tsx");
    const { auth } = await server.ssrLoadModule("/app/shopify.server.ts");
    const shop = auth.shop;
    const productId = id => `gid://shopify/Product/${id}`;
    const seed = async (id, mode = "CATALOG") => {
      const run = id.toString(16).padStart(32, "0");
      await db.importJob.create({ data: { id: run, shop, status: "COMPLETE", selection: JSON.stringify([id]), markup: "25.00",
        markups: JSON.stringify({ [id]: "40.00" }), locationId: "gid://shopify/Location/1", generation: "a".repeat(36), cursor: 1,
        items: { create: [{ supplierId: id, name: `Product ${id}`, sku: `SKU-${id}`, wholesale: '["10.00"]',
          payload: "{}", status: "CREATED", productId: productId(id), fulfillmentMode: mode }] } } });
      await db.importClaim.create({ data: { shop, supplierId: id, productId: productId(id), runId: run, fulfillmentMode: mode } });
    };
    const state = id => db.importClaim.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: id } } });
    const syncState = () => db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId: 200 } } });
    await seed(100);
    await seed(200, "DROPSHIPPING");
    await seed(300, "DROPSHIPPING");
    await seed(400);
    assert.equal((await state(100)).deletedAt, null, "migration defaults preserve existing mappings");
    await db.inventorySync.create({ data: { shop, supplierId: 200, productId: productId(200), locationId: "gid://shopify/Location/1",
      mappings: '[{"sourceId":200,"variantId":"gid://shopify/ProductVariant/200","inventoryItemId":"gid://shopify/InventoryItem/200"}]',
      enabled: true, status: "RUNNING", generation: "a".repeat(36), cursor: 10,
      pending: '{"protected":true}', pendingKey: "b".repeat(32), pendingAt: new Date() } });

    for (const response of [
      {}, { errors: [{ message: "Access denied" }], data: { nodes: [null, null, null, null] } },
      { data: { nodes: [] } }, { data: { nodes: [null, undefined, null, null] } },
      { data: { nodes: [null, { id: productId(999) }, null, null] } },
    ]) {
      await assert.rejects(verifyImportedListings(shop, async () => response), /verification failed|invalid listing identities/);
      assert.equal(await db.importClaim.count({ where: { deletedAt: { not: null } } }), 0,
        "partial, malformed and access-error responses never archive any products");
    }
    await assert.rejects(verifyImportedListings(shop, async () => { throw new Error("Timeout"); }), /Timeout/);
    assert.equal((await state(100)).listingCheckedAt, null);
    const before = await syncState();
    let checks = 0;
    const api = async (query, variables) => {
      assert.equal(query, LISTING_EXISTENCE_QUERY);
      assert.ok(variables.ids.length <= 50);
      checks++;
      return { data: { nodes: variables.ids.map(id => id === productId(400) ? { id } : null) } };
    };
    assert.equal(await verifyImportedListings(shop, api), 4);
    assert.equal(await verifyImportedListings(shop, api), 0, "recently checked and deleted mappings are not repeatedly queried");
    assert.equal(checks, 1);
    assert.ok((await state(100)).deletedAt, "catalog-only products are checked");
    assert.ok((await state(300)).deletedAt, "never-enrolled dropshipping products are checked");
    assert.equal((await state(400)).deletedAt, null, "an existing draft/active listing remains current");
    const after = await syncState();
    assert.equal(after.enabled, false);
    assert.equal(after.status, "REVIEW");
    assert.equal(after.revision, before.revision + 1, "running stock work is invalidated");
    for (const key of ["productId", "mappings", "pending", "pendingKey", "generation", "cursor"]) assert.equal(after[key], before[key]);
    assert.deepEqual(after.pendingAt, before.pendingAt);
    assert.equal(await db.importItem.count(), 4);
    assert.equal((await state(200)).productId, productId(200), "creation guard and historical mapping survive deletion");
    await markListingDeleted(shop, productId(200));
    assert.equal((await syncState()).revision, after.revision, "duplicate notifications are idempotent");
    assert.deepEqual((await state(200)).deletedAt, (await state(200)).listingCheckedAt);
    await assert.rejects(inventoryControl(shop, 200, "sync-now", api), /paused/);
    const bulk = await enableAllInventory(shop, async () => { throw new Error("Archived products must never reach Shopify enrollment"); },
      "inventory-all-current");
    assert.equal(bulk.enabled, 0);
    assert.equal(bulk.alreadyEnabled, 0);
    assert.equal(bulk.total, 1, "archived products are excluded from bulk totals and candidates");
    assert.equal(bulk.blocked.length, 1);
    assert.equal(bulk.blocked[0].supplierId, 400);
    const screen = await inventoryScreen(shop);
    assert.equal(screen.find(item => item.supplierId === 200).enabled, false);
    assert.equal(screen.find(item => item.supplierId === 100).status, "DELETED");
    assert.equal(screen.find(item => item.supplierId === 100).markup, "40.00");

    const render = async (search = "") => {
      const handler = createStaticHandler([{ id: "inventory", path: "/app/inventory", loader, Component: () =>
        createElement(WorkspaceProvider, { shop, saved: { selected: [], markup: "0", markups: {} } }, createElement(Inventory)) }]);
      const context = await handler.query(new Request(`https://fixture.example/app/inventory${search}`));
      return renderToStaticMarkup(createElement(StaticRouterProvider, { context, router: createStaticRouter(handler.dataRoutes, context) }));
    };
    const current = await render();
    const body = current.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
    assert.match(body, /Product 400/);
    assert.doesNotMatch(body, /Product (100|200|300)/);
    assert.match(current, /<strong>1<\/strong> Current imported products/);
    assert.match(current, /<strong>3<\/strong> Deleted \/ archived/);
    assert.doesNotMatch(current, /Enable inventory sync for all/);
    const archived = await render("?filter=deleted");
    const archivedBody = archived.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
    assert.doesNotMatch(archivedBody, /Product 400|Open in Shopify|Enable inventory sync|Sync now|Pause sync/);
    assert.match(archivedBody, /Deleted in Shopify/);
    assert.match(archivedBody, /Review re-import as a new draft/);
    assert.match(archivedBody, /Review connection to existing product/);
    assert.match(archivedBody, /<input(?=[^>]*name="connection")(?=[^>]*required="")[^>]*>/);
    assert.match(archivedBody, /name="markup" value="40.00"/);
    assert.doesNotMatch(archivedBody, /name="active"|name="publish"/, "re-import defaults to an unpublished draft");
    assert.match(archivedBody, /Import confirmation is still required/);
    assert.match(archivedBody, /<form[^>]*action="\/app\?[^"]*&amp;index"/,
      "recovery posts to the import index action, not the workspace parent");

    for (const invalid of [null, {}, { id: 0 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: "bad" }]) {
      assert.throws(() => deletedProductId(invalid), /Invalid/);
    }
    assert.equal(deletedProductId({ id: "788032119674292922" }), productId("788032119674292922"), "string IDs are kept exact");
    assert.equal(deletedProductId({ id: 100 }), productId(100));
    const request = () => new Request("https://fixture.example/webhooks/products/delete", {
      method: "POST", body: JSON.stringify(auth.payload),
    });
    auth.rejected = true;
    await assert.rejects(webhook({ request: request() }), error => error.status === 401);
    auth.rejected = false;
    auth.topic = "PRODUCTS_UPDATE";
    await assert.rejects(webhook({ request: request() }), error => error.status === 400);
    auth.topic = "PRODUCTS_DELETE";
    auth.payload = { id: 400 };
    assert.equal((await webhook({ request: request() })).status, 200);
    assert.ok((await state(400)).deletedAt);
    await db.importClaim.update({ where: { shop_supplierId: { shop, supplierId: 400 } },
      data: { productId: productId(401), deletedAt: null } });
    await webhook({ request: request() });
    assert.equal((await state(400)).deletedAt, null, "a delayed old deletion never archives a replacement mapping");
    await db.importClaim.update({ where: { shop_supplierId: { shop, supplierId: 400 } },
      data: { productId: productId("788032119674292922") } });
    await webhook({ request: new Request("https://fixture.example/webhooks/products/delete", {
      method: "POST", body: '{"id":788032119674292922}',
    }) });
    assert.ok((await state(400)).deletedAt, "signed webhook body preserves large numeric IDs without rounding");
    const archivedOnly = await render();
    assert.match(archivedOnly, /No current imported products/);
    assert.match(archivedOnly, /View deleted \/ archived products/);
    await assert.rejects(markListingDeleted("unrelated.myshopify.com", productId(401)));

    for (let id = 500; id < 560; id++) await seed(id);
    let bounded = 0;
    const live = async (_query, { ids }) => {
      assert.ok(ids.length <= 50);
      bounded++;
      return { data: { nodes: ids.map(id => ({ id })) } };
    };
    assert.equal(await verifyImportedListings(shop, live), 50);
    assert.equal(await verifyImportedListings(shop, live), 10);
    assert.equal(bounded, 2, "all products are visited in bounded batches");
    await db.importClaim.update({ where: { shop_supplierId: { shop, supplierId: 500 } },
      data: { listingCheckedAt: new Date(Date.now() - LISTING_CHECK_INTERVAL - 1) } });
    assert.equal(await verifyImportedListings(shop, live), 1, "existing products are periodically rechecked");
    await db.importClaim.update({ where: { shop_supplierId: { shop, supplierId: 500 } }, data: { listingCheckedAt: null } });
    await verifyImportedListings(shop, async (_query, { ids }) => {
      await db.importClaim.update({ where: { shop_supplierId: { shop, supplierId: 500 } },
        data: { productId: productId(999), deletedAt: null } });
      return { data: { nodes: ids.map(() => null) } };
    });
    assert.equal((await state(500)).deletedAt, null, "stale verification results cannot delete a newer mapping");
    const config = await readFile(new URL("../shopify.app.toml", import.meta.url), "utf8");
    assert.match(config, /topics = \["products\/delete"\]/);
    assert.match(config, /uri = "\/webhooks\/products\/delete"/);
  } finally {
    await db.$disconnect();
    await server.close();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
