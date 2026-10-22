import db from "./db.server";
import { assertLabShop } from "./lab-policy.server";
import { record } from "./import-engine";
import type { GraphQL } from "./import-engine";
import { STATUS_KEY, STATUS_NAMESPACE, importStatus } from "./storefront-status";

const HISTORY_JOBS = 5;
export const STATUS_MUTATION = `mutation ImportStatusPublish($metafields:[MetafieldsSetInput!]!) {
  metafieldsSet(metafields:$metafields) { userErrors { field message } }
}`;
const SHOP_QUERY = `query ImportStatusShop { shop { id } }`;

function variantCount(payload: string) {
  try {
    const value: unknown = JSON.parse(payload);
    return record(value) && Array.isArray(value.variants) ? value.variants.length : 0;
  } catch {
    return 0;
  }
}

export async function importStatusSnapshot(shop: string, now = new Date()) {
  assertLabShop(shop);
  const [jobs, syncs, claims, items] = await Promise.all([
    db.importJob.findMany({ where: { shop, status: { not: "PREVIEW" } }, orderBy: { createdAt: "desc" }, take: HISTORY_JOBS,
      include: { items: { orderBy: { supplierId: "asc" } } } }),
    db.inventorySync.findMany({ where: { shop } }),
    db.importClaim.findMany({ where: { shop, productId: { not: null } }, select: { supplierId: true, deletedAt: true } }),
    db.importItem.findMany({ where: { job: { shop } }, orderBy: { job: { createdAt: "asc" } }, select: { supplierId: true, name: true } }),
  ]);
  return importStatus({
    jobs: jobs.map((job) => ({ ...job, items: job.items.map((item) => ({ supplierId: item.supplierId, name: item.name, sku: item.sku,
      status: item.status, error: item.error, variants: variantCount(item.payload) })) })),
    syncs, claims, names: new Map(items.map((item) => [item.supplierId, item.name])), now,
  });
}

// Writes the snapshot to the shop metafield ultralove.import_status (JSON),
// which the theme's import status section reads.
export async function publishImportStatus(shop: string, api: GraphQL) {
  const snapshot = await importStatusSnapshot(shop);
  const context = await api(SHOP_QUERY, {});
  const ownerId = record(context) && record(context.data) && record(context.data.shop) ? context.data.shop.id : null;
  if (typeof ownerId !== "string" || !ownerId.startsWith("gid://shopify/Shop/")) throw new Error("Shop lookup for import status failed.");
  const result = await api(STATUS_MUTATION, { metafields: [{ ownerId, namespace: STATUS_NAMESPACE, key: STATUS_KEY, type: "json",
    value: JSON.stringify(snapshot) }] });
  const errors = record(result) && record(result.data) && record(result.data.metafieldsSet) ? result.data.metafieldsSet.userErrors : null;
  if (!Array.isArray(errors) || errors.length || (record(result) && Array.isArray(result.errors) && result.errors.length)) {
    throw new Error("Shopify rejected the import status metafield.");
  }
  return snapshot;
}
