import { setTimeout } from "node:timers/promises";
import db from "./db.server";
import shopify from "./shopify.server";
import { approvedShops, assertShopDomain } from "./shop-policy.server";
import { runJob } from "./imports.server";
import { runInventoryBatch } from "./inventory.server";
import { INVENTORY_INTERVAL, INVENTORY_PRODUCT_BATCH_SIZE } from "./inventory-engine";
import { LISTING_CHECK_INTERVAL, verifyImportedListings } from "./listing-lifecycle.server";
import { publishImportStatus } from "./storefront-status.server";
import { STATUS_INTERVAL } from "./storefront-status";
import { pausedInventoryShops } from "./settings.server";
import { feedVersionGate } from "./feed-version.server";

let stopping = false;
let listingRetryAt = 0;
// Storefront status publishing per store: whether work changed it, and when it was last published.
const statuses = new Map<string, { dirty: boolean; publishedAt: number }>();
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

await db.importJob.updateMany({ where: { status: "RUNNING" }, data: { status: "QUEUED" } });
await db.inventorySync.updateMany({ where: { enabled: true, status: "RUNNING" }, data: { status: "QUEUED" } });
console.info("Product import and inventory worker ready.");

function statusOf(shop: string) {
  let status = statuses.get(shop);
  if (!status) statuses.set(shop, status = { dirty: true, publishedAt: 0 });
  return status;
}

function graphql(admin: Awaited<ReturnType<typeof shopify.unauthenticated.admin>>["admin"]) {
  return async (query: string, variables: Record<string, unknown>) => {
    const response = await admin.graphql(query, { variables, tries: 1 });
    return response.json();
  };
}

async function adminFor(shop: string) {
  const { admin, session } = await shopify.unauthenticated.admin(shop);
  if (session.shop !== shop) throw new Error("Shopify returned a session for another store.");
  return graphql(admin);
}

// Refreshes each approved store's storefront import status after work changed it, at most once
// per STATUS_INTERVAL, and at least every 15 minutes so its timestamps stay current.
async function publishStatus(shops: string[]) {
  for (const shop of shops) {
    const status = statusOf(shop);
    const elapsed = Date.now() - status.publishedAt;
    if (elapsed < STATUS_INTERVAL || (!status.dirty && elapsed < 15 * STATUS_INTERVAL)) continue;
    status.publishedAt = Date.now();
    // Stores that never used the app have nothing to show and may not have a session.
    if (!await db.importJob.findFirst({ where: { shop }, select: { id: true } })) continue;
    try {
      await publishImportStatus(shop, await adminFor(shop));
      status.dirty = false;
    } catch (error) {
      console.error("Storefront import status publish failed.", shop, error instanceof Error ? error.message : "Unknown failure");
    }
  }
}

while (!stopping) {
  // Only approved stores get work done; a store that loses approval keeps its data but stops here.
  const shops = await approvedShops();
  const job = await db.importJob.findFirst({ where: { shop: { in: shops }, status: "QUEUED" }, orderBy: { createdAt: "asc" } });
  if (job) {
    assertShopDomain(job.shop);
    Object.assign(statusOf(job.shop), { dirty: true, publishedAt: 0 });
    try {
      await runJob(job.id, job.shop, await adminFor(job.shop), () => stopping);
    } catch (error) {
      console.error("Import worker access failed.", job.id, error instanceof Error ? error.message : "Unknown failure");
      await db.importJob.update({ where: { id: job.id }, data: { status: "FAILED", activeShop: null,
        error: "Shopify access could not be established. Reopen the app, then retry the job." } });
    }
  } else {
    const listing = Date.now() >= listingRetryAt && await db.importClaim.findFirst({
      where: { shop: { in: shops }, productId: { not: null }, deletedAt: null,
        OR: [{ listingCheckedAt: null }, { listingCheckedAt: { lte: new Date(Date.now() - LISTING_CHECK_INTERVAL) } }] },
      select: { shop: true },
    });
    if (listing) {
      try {
        await verifyImportedListings(listing.shop, await adminFor(listing.shop));
      } catch (error) {
        console.error("Imported listing verification failed.", listing.shop, error instanceof Error ? error.message : "Unknown failure");
        listingRetryAt = Date.now() + LISTING_CHECK_INTERVAL;
      }
    }
    // A store paused from Settings keeps its enrolled products' state; they run when sync resumes.
    const paused = await pausedInventoryShops();
    const syncing = shops.filter((shop) => !paused.includes(shop));
    const due = await db.inventorySync.findFirst({ where: { shop: { in: syncing }, enabled: true, nextRunAt: { lte: new Date() }, status: { not: "RUNNING" } },
      orderBy: [{ nextRunAt: "asc" }, { supplierId: "asc" }], select: { shop: true } });
    // One batch covers one store, starting with the store whose product is most overdue.
    const sync = due ? await db.inventorySync.findMany({ where: { shop: due.shop, enabled: true, nextRunAt: { lte: new Date() }, status: { not: "RUNNING" } },
      orderBy: [{ nextRunAt: "asc" }, { supplierId: "asc" }], take: INVENTORY_PRODUCT_BATCH_SIZE }) : [];
    // An unsupported supplier feed schema pauses sync too; feedVersionGate looks again every few minutes.
    if (!due || !sync.length || !(await feedVersionGate("inventory")).allowed) {
      await publishStatus(shops);
      await setTimeout(2000);
      continue;
    }
    statusOf(due.shop).dirty = true;
    try {
      await runInventoryBatch(due.shop, sync.map((item) => item.supplierId), await adminFor(due.shop), () => stopping);
    } catch (error) {
      console.error("Inventory worker access failed.", due.shop, sync.map((item) => item.supplierId), error instanceof Error ? error.message : "Unknown failure");
      await db.inventorySync.updateMany({ where: { shop: due.shop, supplierId: { in: sync.map((item) => item.supplierId) }, enabled: true },
        data: { status: "FAILED", nextRunAt: new Date(Date.now() + INVENTORY_INTERVAL),
          error: "Shopify access could not be established. Reopen the app; the next inventory cycle retries." } });
    }
  }
}
await db.$disconnect();
