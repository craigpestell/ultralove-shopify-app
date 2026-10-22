import { setTimeout } from "node:timers/promises";
import db from "./db.server";
import shopify from "./shopify.server";
import { LAB_SHOP, assertLabShop } from "./lab-policy.server";
import { runJob } from "./imports.server";
import { runInventoryBatch } from "./inventory.server";
import { INVENTORY_INTERVAL, INVENTORY_PRODUCT_BATCH_SIZE } from "./inventory-engine";
import { LISTING_CHECK_INTERVAL, verifyImportedListings } from "./listing-lifecycle.server";
import { publishImportStatus } from "./storefront-status.server";
import { STATUS_INTERVAL } from "./storefront-status";
import { inventoryPaused } from "./settings.server";
import { feedVersionGate } from "./feed-version.server";

let stopping = false;
let listingRetryAt = 0;
let statusDirty = true;
let statusPublishedAt = 0;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

assertLabShop(LAB_SHOP);
await db.importJob.updateMany({ where: { shop: LAB_SHOP, status: "RUNNING" }, data: { status: "QUEUED" } });
await db.inventorySync.updateMany({ where: { shop: LAB_SHOP, enabled: true, status: "RUNNING" }, data: { status: "QUEUED" } });
console.info("Lab-only product import and inventory worker ready.");

// Refreshes the storefront import status after work changed it, at most once
// per STATUS_INTERVAL, and at least every 15 minutes so its timestamps stay current.
async function publishStatus() {
  const elapsed = Date.now() - statusPublishedAt;
  if (elapsed < STATUS_INTERVAL || (!statusDirty && elapsed < 15 * STATUS_INTERVAL)) return;
  statusPublishedAt = Date.now();
  try {
    const { admin, session } = await shopify.unauthenticated.admin(LAB_SHOP);
    assertLabShop(session.shop);
    await publishImportStatus(LAB_SHOP, async (query, variables) => {
      const response = await admin.graphql(query, { variables, tries: 1 });
      return response.json();
    });
    statusDirty = false;
  } catch (error) {
    console.error("Storefront import status publish failed.", error instanceof Error ? error.message : "Unknown failure");
  }
}

while (!stopping) {
  const job = await db.importJob.findFirst({ where: { shop: LAB_SHOP, status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (job) {
    statusDirty = true;
    statusPublishedAt = 0;
    try {
      const { admin, session } = await shopify.unauthenticated.admin(LAB_SHOP);
      assertLabShop(session.shop);
      await runJob(job.id, LAB_SHOP, async (query, variables) => {
        const response = await admin.graphql(query, { variables, tries: 1 });
        return response.json();
      }, () => stopping);
    } catch (error) {
      console.error("Import worker access failed.", job.id, error instanceof Error ? error.message : "Unknown failure");
      await db.importJob.update({ where: { id: job.id }, data: { status: "FAILED", activeShop: null,
        error: "Shopify access could not be established. Reopen the app, then retry the job." } });
    }
  } else {
    const listing = Date.now() >= listingRetryAt && await db.importClaim.findFirst({
      where: { shop: LAB_SHOP, productId: { not: null }, deletedAt: null,
        OR: [{ listingCheckedAt: null }, { listingCheckedAt: { lte: new Date(Date.now() - LISTING_CHECK_INTERVAL) } }] },
      select: { supplierId: true },
    });
    if (listing) {
      try {
        const { admin, session } = await shopify.unauthenticated.admin(LAB_SHOP);
        assertLabShop(session.shop);
        await verifyImportedListings(LAB_SHOP, async (query, variables) => {
          const response = await admin.graphql(query, { variables, tries: 1 });
          return response.json();
        });
      } catch (error) {
        console.error("Imported listing verification failed.", error instanceof Error ? error.message : "Unknown failure");
        listingRetryAt = Date.now() + LISTING_CHECK_INTERVAL;
      }
    }
    // Paused from Settings: enrolled products keep their state and run when sync resumes.
    const sync = await inventoryPaused() ? [] : await db.inventorySync.findMany({ where: { shop: LAB_SHOP, enabled: true, nextRunAt: { lte: new Date() }, status: { not: "RUNNING" } },
      orderBy: [{ nextRunAt: "asc" }, { supplierId: "asc" }], take: INVENTORY_PRODUCT_BATCH_SIZE });
    // An unsupported supplier feed schema pauses sync too; feedVersionGate looks again every few minutes.
    if (!sync.length || !(await feedVersionGate("inventory")).allowed) {
      await publishStatus();
      await setTimeout(2000);
      continue;
    }
    statusDirty = true;
    try {
      const { admin, session } = await shopify.unauthenticated.admin(LAB_SHOP);
      assertLabShop(session.shop);
      await runInventoryBatch(LAB_SHOP, sync.map((item) => item.supplierId), async (query, variables) => {
        const response = await admin.graphql(query, { variables, tries: 1 });
        return response.json();
      }, () => stopping);
    } catch (error) {
      console.error("Inventory worker access failed.", sync.map((item) => item.supplierId), error instanceof Error ? error.message : "Unknown failure");
      await db.inventorySync.updateMany({ where: { shop: LAB_SHOP, supplierId: { in: sync.map((item) => item.supplierId) }, enabled: true },
        data: { status: "FAILED", nextRunAt: new Date(Date.now() + INVENTORY_INTERVAL),
          error: "Shopify access could not be established. Reopen the app; the next inventory cycle retries." } });
    }
  }
}
await db.$disconnect();
