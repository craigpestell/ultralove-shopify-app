import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";

test("uninstall stops one store's work, shop/redact deletes its data, and pauses are per store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ultralove-shop-data-"));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${join(directory, "test.sqlite")}`;
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom" });
  const { default: db } = await server.ssrLoadModule("/app/db.server.ts");
  try {
    for (const migration of (await readdir(new URL("../prisma/migrations/", import.meta.url))).filter((name) => /^\d/.test(name)).sort()) {
      const sql = await readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8");
      for (const statement of sql.split(";").filter((part) => part.trim())) await db.$executeRawUnsafe(statement);
    }
    const { stopShopWork, deleteShopData } = await server.ssrLoadModule("/app/shop-data.server.ts");
    const { inventoryPaused, pausedInventoryShops, updateInventoryPaused, appSettings } = await server.ssrLoadModule("/app/settings.server.ts");
    const gone = "gone.myshopify.com";
    const kept = "kept.myshopify.com";
    for (const shop of [gone, kept]) {
      await db.session.create({ data: { id: `offline_${shop}`, shop, state: "", accessToken: "token" } });
      await db.catalogSelection.create({ data: { shop, productIds: "[1]" } });
      for (const [suffix, status] of [["queued", "QUEUED"], ["done", "COMPLETE"]]) {
        await db.importJob.create({ data: { id: `${shop}-${suffix}`, shop, status, selection: "[1]", markup: "0.00",
          locationId: "gid://shopify/Location/1", generation: "a".repeat(36), cursor: 0,
          items: { create: [{ supplierId: 1, name: "Product", sku: "SKU", wholesale: "1.00", payload: "{}" }] } } });
      }
      await db.importClaim.create({ data: { shop, supplierId: 1, runId: "run", productId: "gid://shopify/Product/1" } });
      await db.inventorySync.create({ data: { shop, supplierId: 1, productId: "gid://shopify/Product/1", locationId: "gid://shopify/Location/1",
        mappings: "[]", enabled: true, status: "SYNCED" } });
    }

    await updateInventoryPaused(kept, true);
    assert.equal(await inventoryPaused(kept), true);
    assert.equal(await inventoryPaused(gone), false, "one store's pause never pauses another");
    assert.deepEqual(await pausedInventoryShops(), [kept]);
    assert.equal((await appSettings(gone)).inventoryPaused, false);
    assert.equal((await appSettings(kept)).autoUpdates, true, "automatic updates stay on before the row exists");

    await stopShopWork(gone);
    await stopShopWork(gone);
    assert.equal(await db.session.count({ where: { shop: gone } }), 0);
    assert.equal((await db.importJob.findUnique({ where: { id: `${gone}-queued` } })).status, "FAILED");
    assert.equal((await db.importJob.findUnique({ where: { id: `${gone}-done` } })).status, "COMPLETE", "finished history is kept");
    const sync = await db.inventorySync.findUnique({ where: { shop_supplierId: { shop: gone, supplierId: 1 } } });
    assert.deepEqual([sync.enabled, sync.status, sync.revision], [false, "PAUSED", 1], "a repeated uninstall changes nothing more");
    assert.equal(await db.importClaim.count({ where: { shop: gone } }), 1, "listing links survive until shop/redact");
    assert.equal(await db.catalogSelection.count({ where: { shop: gone } }), 1);

    await deleteShopData(gone);
    for (const table of ["session", "catalogSelection", "importJob", "importClaim", "inventorySync", "shopSettings"]) {
      assert.equal(await db[table].count({ where: { shop: gone } }), 0, `${table} is deleted`);
    }
    assert.equal(await db.importItem.count({ where: { job: { shop: gone } } }), 0);
    assert.equal(await db.importItem.count(), 2, "another store's items stay");
    for (const table of ["session", "catalogSelection", "importClaim", "inventorySync", "shopSettings"]) {
      assert.equal(await db[table].count({ where: { shop: kept } }), 1, `another store's ${table} stays`);
    }
    assert.equal((await db.importJob.findUnique({ where: { id: `${kept}-queued` } })).status, "QUEUED");
    await assert.rejects(deleteShopData("ultralove.ca"), (error) => error instanceof Response && error.status === 403);
  } finally {
    await db.$disconnect();
    await server.close();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
