import db from "./db.server";
import { assertLabShop } from "./lab-policy.server";
import { record } from "./import-engine";
import type { GraphQL } from "./import-engine";
import { InventoryError } from "./inventory-engine";

export const LISTING_CHECK_INTERVAL = 5 * 60 * 1000;
export const LISTING_CHECK_BATCH_SIZE = 50;
export const LISTING_EXISTENCE_QUERY = `query ImportedListingExistence($ids:[ID!]!) {
  nodes(ids:$ids) { ... on Product { id } }
}`;

export function deletedProductId(value: unknown): string {
  if (!record(value)) throw new InventoryError("Invalid product deletion webhook.");
  const id = value.id;
  if ((typeof id !== "string" || !/^[1-9]\d*$/.test(id)) &&
      (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)) {
    throw new InventoryError("Invalid deleted Shopify product ID.");
  }
  return `gid://shopify/Product/${id}`;
}

export async function markListingDeleted(shop: string, productId: string) {
  assertLabShop(shop);
  if (!/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(productId)) throw new InventoryError("Invalid Shopify listing ID.");
  const deletedAt = new Date();
  await db.$transaction(async (transaction) => {
    const marked = await transaction.importClaim.updateMany({
      where: { shop, productId, deletedAt: null },
      data: { deletedAt, listingCheckedAt: deletedAt },
    });
    if (!marked.count) return;
    await transaction.inventorySync.updateMany({
      where: { shop, productId },
      data: { enabled: false, status: "REVIEW", revision: { increment: 1 },
        error: "Deleted in Shopify: the linked Shopify product could not be found. Supplier sync is stopped. Review a new draft or connect an existing listing. Any pending stock correction remains protected." },
    });
  });
}

export async function verifyImportedListings(shop: string, api: GraphQL) {
  assertLabShop(shop);
  const claims = await db.importClaim.findMany({
    where: { shop, productId: { not: null }, deletedAt: null,
      OR: [{ listingCheckedAt: null }, { listingCheckedAt: { lte: new Date(Date.now() - LISTING_CHECK_INTERVAL) } }] },
    orderBy: [{ listingCheckedAt: "asc" }, { supplierId: "asc" }], take: LISTING_CHECK_BATCH_SIZE,
  });
  if (!claims.length) return 0;
  const ids = claims.map((claim) => claim.productId!);
  const response: unknown = await api(LISTING_EXISTENCE_QUERY, { ids });
  if (!record(response) || (response.errors !== undefined &&
      (!Array.isArray(response.errors) || response.errors.length)) ||
      !record(response.data) || !Array.isArray(response.data.nodes) || response.data.nodes.length !== ids.length) {
    throw new InventoryError("Shopify listing verification failed. No products were marked deleted.");
  }
  const nodes: unknown[] = response.data.nodes;
  if (nodes.some((node, index) => node !== null && (!record(node) || node.id !== ids[index]))) {
    throw new InventoryError("Shopify returned invalid listing identities. No products were marked deleted.");
  }
  for (const [index, productId] of ids.entries()) {
    if (nodes[index] === null) await markListingDeleted(shop, productId);
    else await db.importClaim.updateMany({
      where: { shop, supplierId: claims[index].supplierId, productId, deletedAt: null },
      data: { listingCheckedAt: new Date() },
    });
  }
  return claims.length;
}
