import { setTimeout } from "node:timers/promises";
import db from "./db.server";
import shopify from "./shopify.server";
import { LAB_SHOP, assertLabShop } from "./lab-policy.server";
import { runJob } from "./imports.server";
import { runInventoryBatch } from "./inventory.server";
import { INVENTORY_INTERVAL, INVENTORY_PRODUCT_BATCH_SIZE } from "./inventory-engine";
import { LISTING_CHECK_INTERVAL, verifyImportedListings } from "./listing-lifecycle.server";

let stopping = false;
let listingRetryAt = 0;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

assertLabShop(LAB_SHOP);
await db.importJob.updateMany({ where: { shop: LAB_SHOP, status: "RUNNING" }, data: { status: "QUEUED" } });
await db.inventorySync.updateMany({ where: { shop: LAB_SHOP, enabled: true, status: "RUNNING" }, data: { status: "QUEUED" } });
console.info("Lab-only product import and inventory worker ready.");
while (!stopping) {
  const job = await db.importJob.findFirst({ where: { shop: LAB_SHOP, status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (job) {
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
    const sync = await db.inventorySync.findMany({ where: { shop: LAB_SHOP, enabled: true, nextRunAt: { lte: new Date() }, status: { not: "RUNNING" } },
      orderBy: [{ nextRunAt: "asc" }, { supplierId: "asc" }], take: INVENTORY_PRODUCT_BATCH_SIZE });
    if (!sync.length) {
      await setTimeout(2000);
      continue;
    }
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
