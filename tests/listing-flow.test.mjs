import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { CATALOG_QUERY, CONTEXT_QUERY, CREATE_MUTATION, VERIFY_QUERY, MAX_PREVIEW_AGE } from "../app/import-engine.ts";
import { defaultListingPolicy } from "../app/listing-policy.ts";
import { LISTING_METADATA_MUTATION, LISTING_PRICES_MUTATION, LISTING_QUERY } from "../app/listing-engine.ts";
import { listingApi, retailerListing, supplierInput, location } from "./fixtures/listing-fixture.mjs";

test("Prisma listing previews/worker persist approvals, recover missing mappings and reconcile partial operations safely", async () => {
  const directory = join(process.cwd(), `.test-listing-flow-${randomUUID()}`);
  await mkdir(directory);
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${join(directory, "test.sqlite")}`;
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom",
    plugins: [{ name: "listing-supplier-fixture", enforce: "pre", load(id) {
      if (!id.endsWith("/app/catalog.server.ts")) return;
      return `
        import { retailPrice } from "/app/pricing-policy.ts";
        const source = ${JSON.stringify(supplierInput)};
        export async function validateSelection() {}
        export async function importPlan(ids, location, run, markup) {
          return { generation: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", cursor: 1,
            items: ids.map(id => ({ supplierId:id,name:"Supplier title",sku:"SKU-"+id,wholesale:["12.50"],
              payload:{...structuredClone(source),handle:"ultralove-catalog-"+id,
                tags:["ultralove-catalog-import","ultralove-catalog-run-"+run],
                metafields:[{namespace:"ultralove_catalog",key:"supplier_id",value:String(id)}],
                variants:[{...structuredClone(source.variants[0]),sku:"SKU-"+id,price:retailPrice("12.50",markup),
                  metafields:[{namespace:"ultralove_catalog",key:"supplier_id",value:String(id)}]}] }})) };
        }`;
    } }],
  });
  const { default: db } = await server.ssrLoadModule("/app/db.server.ts");
  const shop = "ultralove-integration-lab.myshopify.com";
  try {
    for (const migration of (await readdir(new URL("../prisma/migrations/", import.meta.url))).filter((name) => /^\d/.test(name)).sort()) {
      const sql = await readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8");
      for (const statement of sql.split(";").filter((value) => value.trim())) await db.$executeRawUnsafe(statement);
    }
    const { createPreview, importScreen, queueJob, runJob } = await server.ssrLoadModule("/app/imports.server.ts");
    const { inventoryScreen } = await server.ssrLoadModule("/app/inventory.server.ts");
    const mock = listingApi();
    let creates = 0;
    let createFailure = null;
    let catalogHidden = false;
    let createdInput;
    const api = async (query, variables) => {
      if (query === CONTEXT_QUERY) return { data: {
        shop: { myshopifyDomain: shop, currencyCode: "CAD" },
        locations: { nodes: [{ id: location, name: "Shop location", isActive: true, fulfillsOnlineOrders: true }], pageInfo: { hasNextPage: false } },
      } };
      if (query === CATALOG_QUERY) return { data: { products: { nodes: mock.state.product && !catalogHidden ? [{
        ...structuredClone(mock.state.product), variants: { nodes: mock.state.product.variants },
      }] : [], pageInfo: { hasNextPage: false } } } };
      if (query === CREATE_MUTATION) {
        creates++;
        const claim = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: 100 } } });
        assert.ok(claim.mutationStartedAt);
        const job = await db.importJob.findFirst({ where: { status: "RUNNING" } });
        assert.equal(claim.runId, job.id, "replacement CAS records this run before the API request");
        assert.equal(claim.productId, null);
        if (createFailure === "before") throw new Error("Unknown create outcome before response");
        createdInput = variables.input;
        mock.state.product = retailerListing({ id: `gid://shopify/Product/${creates + 100}` });
        Object.assign(mock.state.product, { title: createdInput.title, descriptionHtml: createdInput.descriptionHtml,
          vendor: createdInput.vendor, status: "DRAFT", handle: createdInput.handle, tags: createdInput.tags });
        mock.state.product.variants[0] = {
          ...mock.state.product.variants[0], id: "gid://shopify/ProductVariant/110", sku: createdInput.variants[0].sku,
          price: createdInput.variants[0].price, barcode: null, inventoryPolicy: "DENY",
          inventoryItem: { id: "gid://shopify/InventoryItem/120", tracked: true },
        };
        if (createFailure === "after") throw new Error("Unknown create outcome after response");
        return { data: { productSet: { product: {
          ...mock.state.product, variants: { nodes: mock.state.product.variants },
        }, userErrors: [] } } };
      }
      if (query === VERIFY_QUERY) return { data: { product: {
        status: mock.state.product.status, variants: { nodes: [{
          ...mock.state.product.variants[0], inventoryItem: { tracked: true,
            inventoryLevel: { quantities: [{ name: "available", quantity: 0 }] } },
        }], pageInfo: { hasNextPage: false } },
      } } };
      return mock.api(query, variables);
    };
    const reset = async (product = retailerListing(), mapped = true) => {
      await db.importItem.deleteMany(); await db.importJob.deleteMany();
      await db.inventorySync.deleteMany(); await db.importClaim.deleteMany();
      await db.catalogSelection.upsert({ where: { shop }, create: { shop, productIds: "[100]" }, update: { productIds: "[100]" } });
      mock.state.product = product; mock.state.calls = []; mock.state.failAfter = null; mock.state.failBefore = null;
      mock.state.before = null; createFailure = null; catalogHidden = false;
      if (mapped) await db.importClaim.create({ data: { shop, supplierId: 100, runId: "a".repeat(32),
        productId: "gid://shopify/Product/1", mutationStartedAt: new Date() } });
    };
    const preview = (policy) => createPreview(shop, "25", api, undefined, undefined, policy);
    const execute = async (job) => {
      const screen = await importScreen(shop, job.id);
      await queueJob(shop, job.id, false, screen.job.confirmation);
      await runJob(job.id, shop, api, () => false);
      return (await importScreen(shop, job.id)).job;
    };
    await reset();
    const keep = await preview();
    assert.equal((await importScreen(shop, keep.id)).job.items[0].listing.action, "KEEP");
    assert.equal((await execute(keep)).items[0].status, "REUSED");
    assert.equal(mock.state.calls.length, 0);
    assert.equal(creates, 0);

    const updates = { ...defaultListingPolicy(), mode: "UPDATE", prices: true };
    const update = await preview(updates);
    const updateScreen = await importScreen(shop, update.id);
    assert.deepEqual(updateScreen.job.listingPolicy, updates);
    assert.ok(updateScreen.job.confirmation.length < 1000);
    assert.equal(updateScreen.job.items[0].listing.changes[0].before, "42.00");
    await assert.rejects(queueJob(shop, update.id, false, "draft-only"), /saved import visibility/);
    mock.state.failAfter = LISTING_PRICES_MUTATION;
    const failedUpdate = await execute(update);
    assert.equal(failedUpdate.status, "FAILED");
    mock.state.failAfter = null;
    await queueJob(shop, update.id, true, updateScreen.job.confirmation);
    await runJob(update.id, shop, api, () => false);
    assert.equal((await importScreen(shop, update.id)).job.items[0].status, "UPDATED");
    assert.equal(mock.state.calls.length, 1);
    assert.equal((await inventoryScreen(shop))[0].productId, "gid://shopify/Product/1");
    assert.equal((await importScreen(shop, update.id)).history.find((job) => job.id === update.id).completed, 1);

    await reset(retailerListing({ owned: false, id: "gid://shopify/Product/2" }), false);
    const linkPolicy = { ...defaultListingPolicy(), links: { 100: "gid://shopify/Product/2" } };
    const link = await preview(linkPolicy);
    assert.equal((await importScreen(shop, link.id)).job.items[0].listing.action, "LINK");
    mock.state.failAfter = LISTING_METADATA_MUTATION;
    assert.equal((await execute(link)).status, "FAILED");
    mock.state.failAfter = null;
    await queueJob(shop, link.id, true, (await importScreen(shop, link.id)).job.confirmation);
    await runJob(link.id, shop, api, () => false);
    const linked = (await importScreen(shop, link.id)).job;
    assert.equal(linked.items[0].status, "LINKED");
    assert.equal(mock.state.product.handle, "retailer-handle");
    assert.equal(mock.state.product.variants[0].price, "42.00");
    assert.equal((await inventoryScreen(shop))[0].productId, "gid://shopify/Product/2");
    const keptLink = await preview();
    assert.equal((await execute(keptLink)).items[0].status, "REUSED");

    await reset(retailerListing({ owned: false, id: "gid://shopify/Product/2" }), false);
    await db.importClaim.create({ data: { shop, supplierId: 101, runId: "b".repeat(32), productId: "gid://shopify/Product/2" } });
    await assert.rejects(preview(linkPolicy), /claimed or enrolled/);
    assert.equal(mock.state.calls.length, 0);
    assert.equal(await db.importJob.count(), 0);

    await reset(retailerListing({ owned: false, id: "gid://shopify/Product/2" }));
    const reconnectPolicy = { ...updates, content: true, images: false, links: { "100": "gid://shopify/Product/2" } };
    const reconnect = await preview(reconnectPolicy);
    const reconnectReview = (await importScreen(shop, reconnect.id)).job.items[0].listing;
    assert.equal(reconnectReview.action, "LINK");
    assert.ok(reconnectReview.changes.some((change) => change.field === "Product name"));
    assert.equal((await execute(reconnect)).items[0].status, "LINKED");
    assert.equal(mock.state.product.title, "Supplier title");
    assert.equal(mock.state.product.variants[0].price, "15.63");
    assert.equal(mock.state.product.handle, "retailer-handle");
    assert.equal(mock.state.product.status, "ACTIVE");
    assert.equal((await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: 100 } } })).productId,
      "gid://shopify/Product/2");

    await reset(retailerListing({ owned: false, id: "gid://shopify/Product/2" }), false);
    mock.state.product.variants[0].sku = "unrelated SKU";
    const ambiguous = await preview(linkPolicy);
    assert.equal((await importScreen(shop, ambiguous.id)).job.items[0].listing.action, "BLOCKED");
    await assert.rejects(execute(ambiguous), /listing|reconnect|review|variants/i);
    assert.equal(mock.state.calls.length, 0);

    await reset();
    mock.state.product.tags = ["retailer-tag"];
    const lostMarkers = await preview(defaultListingPolicy());
    assert.equal((await importScreen(shop, lostMarkers.id)).job.items[0].listing.action, "BLOCKED");
    const restoreMarkers = await preview({ ...linkPolicy, links: { "100": "gid://shopify/Product/1" } });
    assert.equal((await execute(restoreMarkers)).items[0].status, "LINKED");
    assert.equal(mock.state.product.title, "Retailer title");
    assert.ok(mock.state.product.tags.includes("retailer-tag"));

    await reset(retailerListing({ owned: false, id: "gid://shopify/Product/2" }));
    await db.inventorySync.create({ data: { shop, supplierId: 100, productId: "gid://shopify/Product/1", locationId: location,
      mappings: '[{"sourceId":100,"variantId":"gid://shopify/ProductVariant/10","inventoryItemId":"gid://shopify/InventoryItem/20"}]',
      enabled: false } });
    const racingBinding = await preview(linkPolicy);
    let linkedReads = 0;
    mock.state.before = async (query) => {
      if (query === LISTING_QUERY && mock.state.product.tags.includes("ultralove-catalog-linked") && ++linkedReads === 4) {
        await db.inventorySync.update({ where: { shop_supplierId: { shop, supplierId: 100 } },
          data: { revision: { increment: 1 } } });
      }
    };
    const bindingFailure = await execute(racingBinding);
    assert.equal(bindingFailure.status, "FAILED");
    assert.match(bindingFailure.items[0].error, /binding changed concurrently/);
    assert.equal((await db.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId: 100 } } })).productId,
      "gid://shopify/Product/1");
    mock.state.before = null;
    await queueJob(shop, racingBinding.id, true, bindingFailure.confirmation);
    await runJob(racingBinding.id, shop, api, () => false);
    assert.equal((await importScreen(shop, racingBinding.id)).job.status, "COMPLETE");
    assert.equal((await db.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId: 100 } } })).enabled, false);

    await reset(null);
    const missing = await preview();
    const blocked = (await importScreen(shop, missing.id)).job;
    assert.equal(blocked.items[0].listing.action, "BLOCKED");
    assert.equal(blocked.items[0].listing.message, "Previously linked Shopify product could not be found. Reconnect it or explicitly create a replacement.");
    await assert.rejects(queueJob(shop, missing.id, false), /Resolve blocked listings/);
    const replacementPolicy = { ...defaultListingPolicy(), recreate: [100] };
    const replacement = await preview(replacementPolicy);
    assert.equal((await importScreen(shop, replacement.id)).job.items[0].listing.action, "RECREATE");
    createFailure = "after";
    assert.equal((await execute(replacement)).status, "FAILED");
    const createsAtFailure = creates;
    const reserved = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: 100 } } });
    assert.equal(reserved.runId, replacement.id); assert.equal(reserved.productId, null); assert.ok(reserved.mutationStartedAt);
    createFailure = null;
    await queueJob(shop, replacement.id, true, (await importScreen(shop, replacement.id)).job.confirmation);
    await runJob(replacement.id, shop, api, () => false);
    assert.equal((await importScreen(shop, replacement.id)).job.status, "COMPLETE");
    assert.equal(creates, createsAtFailure, "uncertain replacement reconciles the own-run product without a second creation");
    assert.equal(mock.state.product.status, "DRAFT");
    const work = JSON.parse((await db.importItem.findFirst({ where: { jobId: replacement.id } })).listingWork);
    assert.equal(work.expectedProductId, "gid://shopify/Product/1");
    assert.equal(work.replacementReserved, true);

    await reset(null);
    const absentReplacement = await preview(replacementPolicy);
    createFailure = "before";
    assert.equal((await execute(absentReplacement)).status, "FAILED");
    const beforeRetry = creates;
    createFailure = null;
    await queueJob(shop, absentReplacement.id, true, (await importScreen(shop, absentReplacement.id)).job.confirmation);
    await runJob(absentReplacement.id, shop, api, () => false);
    assert.equal(creates, beforeRetry);
    assert.match((await importScreen(shop, absentReplacement.id)).job.items[0].error, /previous creation may/);
    assert.equal((await importScreen(shop, (await preview(replacementPolicy)).id)).job.items[0].listing.action, "BLOCKED",
      "a fresh replacement preview cannot reset an ambiguous mappingless creation claim");

    await reset();
    mock.state.product.tags = ["retailer-tag"];
    catalogHidden = true;
    const existsReplacement = await preview(replacementPolicy);
    assert.equal((await importScreen(shop, existsReplacement.id)).job.items[0].listing.action, "BLOCKED",
      "live old products cannot be recreated just because their catalog markers changed");

    await reset(null);
    await db.inventorySync.create({ data: { shop, supplierId: 100, productId: "gid://shopify/Product/1", locationId: location,
      mappings: '[{"sourceId":100,"variantId":"gid://shopify/ProductVariant/10","inventoryItemId":"gid://shopify/InventoryItem/20"}]',
      enabled: true } });
    assert.match((await importScreen(shop, (await preview(replacementPolicy)).id)).job.items[0].listing.message, /Pause inventory/);
    await db.inventorySync.update({ where: { shop_supplierId: { shop, supplierId: 100 } }, data: { enabled: false } });
    const pausedReplacement = await preview(replacementPolicy);
    assert.equal((await execute(pausedReplacement)).status, "COMPLETE");
    const binding = await db.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId: 100 } } });
    assert.equal(binding.enabled, false); assert.equal(binding.status, "PAUSED");
    assert.equal(binding.productId, mock.state.product.id);
    assert.equal(JSON.parse(binding.mappings)[0].variantId, "gid://shopify/ProductVariant/110");
    assert.equal(JSON.parse(binding.mappings)[0].inventoryItemId, "gid://shopify/InventoryItem/120");

    await reset();
    const staleUpdate = await preview(updates);
    mock.state.product.variants[0].barcode = "concurrent edit";
    assert.equal((await execute(staleUpdate)).status, "FAILED");
    assert.equal(mock.state.calls.length, 0);
    const expiredUpdate = await preview(updates);
    const expiredItem = await db.importItem.findFirst({ where: { jobId: expiredUpdate.id } });
    const expiredWork = JSON.parse(expiredItem.listingWork);
    expiredWork.capturedAt = Date.now() - MAX_PREVIEW_AGE - 1;
    await db.importItem.update({ where: { jobId_supplierId: { jobId: expiredUpdate.id, supplierId: 100 } }, data: { listingWork: JSON.stringify(expiredWork) } });
    assert.equal((await execute(expiredUpdate)).status, "FAILED");
    assert.equal(mock.state.calls.length, 0);

    await reset(null);
    const concurrent = await preview(replacementPolicy);
    await db.importClaim.update({ where: { shop_supplierId: { shop, supplierId: 100 } }, data: { runId: "c".repeat(32) } });
    const previousCreates = creates;
    assert.equal((await execute(concurrent)).status, "FAILED");
    assert.equal(creates, previousCreates);
    assert.equal(mock.state.calls.length, 0);
    // Legacy jobs expose a complete contract despite having no saved listing review.
    await db.importItem.update({ where: { jobId_supplierId: { jobId: concurrent.id, supplierId: 100 } }, data: { listing: "{}" } });
    assert.ok((await importScreen(shop, concurrent.id)).job.items[0].listing.changes);
    assert.ok([LISTING_QUERY, CREATE_MUTATION].every((query) => typeof query === "string"));
  } finally {
    await db.$disconnect(); await server.close();
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    await rm(directory, { recursive: true });
  }
});
