import db from "./db.server";
import { assertShopDomain } from "./shop-policy.server";

/**
 * After an uninstall: drop the store's sessions, stop queued imports and turn inventory sync off.
 * Selections, import history and listing links stay until Shopify's shop/redact request, so a
 * store that reinstalls within that window keeps its work. Safe to run more than once.
 */
export async function stopShopWork(shop: string) {
  assertShopDomain(shop);
  await db.$transaction([
    db.session.deleteMany({ where: { shop } }),
    db.importJob.updateMany({ where: { shop, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "FAILED", activeShop: null, error: "The app was uninstalled from this store." } }),
    db.inventorySync.updateMany({ where: { shop, enabled: true },
      data: { enabled: false, status: "PAUSED", revision: { increment: 1 }, error: "The app was uninstalled from this store. Turn sync on again after reinstalling." } }),
  ]);
}

/** Answers Shopify's shop/redact request: deletes everything the app stored for the store. */
export async function deleteShopData(shop: string) {
  assertShopDomain(shop);
  const jobs = await db.importJob.findMany({ where: { shop }, select: { id: true } });
  await db.$transaction([
    db.importItem.deleteMany({ where: { jobId: { in: jobs.map((job) => job.id) } } }),
    db.importJob.deleteMany({ where: { shop } }),
    db.importClaim.deleteMany({ where: { shop } }),
    db.inventorySync.deleteMany({ where: { shop } }),
    db.catalogSelection.deleteMany({ where: { shop } }),
    db.shopSettings.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);
}
