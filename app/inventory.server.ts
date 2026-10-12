import { randomBytes } from "node:crypto";
import db from "./db.server";
import { assertLabShop } from "./lab-policy.server";
import { CatalogError, inventoryState } from "./catalog.server";
import { payload, shopContext } from "./import-engine";
import type { GraphQL } from "./import-engine";
import {
  checkpoint, INVENTORY_INTERVAL, inventoryFeed, InventoryError, InventoryMutationError, InventoryProductMissingError,
  mappings, remoteInventory, setStock, stockOperation, stockPlan, verifyMappings,
} from "./inventory-engine";
import type { StockOperation } from "./inventory-engine";

export async function inventoryScreen(shop: string) {
  assertLabShop(shop);
  const [claims, items, states] = await Promise.all([
    db.importClaim.findMany({ where: { shop, productId: { not: null } }, orderBy: { supplierId: "asc" } }),
    db.importItem.findMany({ where: { job: { shop }, status: { in: ["CREATED", "REUSED", "UPDATED", "LINKED"] }, productId: { not: null } },
      orderBy: { job: { createdAt: "desc" } }, select: { supplierId: true, productId: true, name: true, sku: true } }),
    db.inventorySync.findMany({ where: { shop } }),
  ]);
  const latestItems = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    const key = `${item.supplierId}:${item.productId}`;
    if (!latestItems.has(key)) latestItems.set(key, item);
  }
  const syncStates = new Map(states.map((state) => [state.supplierId, state]));
  return claims.flatMap((claim) => {
    const item = latestItems.get(`${claim.supplierId}:${claim.productId}`);
    if (!item) return [];
    const state = syncStates.get(claim.supplierId);
    return [{
      supplierId: claim.supplierId, productId: claim.productId, name: item.name, sku: item.sku,
      enabled: state?.enabled || false, status: state?.status || "NOT_ENROLLED",
      error: state?.error || null, variantCount: state ? mappings(JSON.parse(state.mappings)).length : null,
      lastSuccessAt: state?.lastSuccessAt?.toISOString() || null,
      nextRunAt: state?.enabled ? state.nextRunAt.toISOString() : null,
    }];
  });
}

export async function inventoryControl(shop: string, supplierId: number, intent: string, api: GraphQL, confirmation?: string) {
  assertLabShop(shop);
  if (!Number.isInteger(supplierId) || supplierId < 1 || supplierId > 2147483647) throw new InventoryError("Invalid supplier inventory product.");
  if (intent === "pause" || intent === "sync-now") {
    const updated = await db.inventorySync.updateMany({
      where: { shop, supplierId, ...(intent === "sync-now" ? { enabled: true, status: { not: "RUNNING" } } : {}) },
      data: intent === "pause" ? { enabled: false, status: "PAUSED", revision: { increment: 1 } }
        : { nextRunAt: new Date(), status: "QUEUED" },
    });
    if (updated.count !== 1) throw new InventoryError("This product is not enrolled, is paused, or already has a running cycle. Refresh its status.");
    return;
  }
  if (intent !== "enable" || confirmation !== "inventory-only") {
    throw new InventoryError("Confirm inventory-only synchronization before enabling it.");
  }
  const claim = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId } } });
  if (!claim?.productId) throw new InventoryError("Import this product through the app before enabling inventory sync.");
  const imported = await db.importItem.findFirst({
    where: { supplierId, productId: claim.productId, status: { in: ["CREATED", "REUSED", "UPDATED", "LINKED"] }, job: { shop } },
    orderBy: { job: { createdAt: "desc" } }, include: { job: true },
  });
  if (!imported) throw new InventoryError("A verified completed import is required before inventory enrollment.");
  const location = await shopContext(api, shop);
  if (location !== imported.job.locationId) throw new InventoryError("The approved inventory location changed. Review the imported product.");
  const input = payload(JSON.parse(imported.payload), supplierId, imported.jobId, location);
  const sources = input.variants.map((variant) => Number(variant.metafields.find((field) =>
    field.namespace === "ultralove_catalog" && field.key === "supplier_id")?.value)).sort((a, b) => a - b);
  const current = await remoteInventory(api, claim.productId, supplierId, location);
  const verified = mappings(current);
  if (JSON.stringify(sources) !== JSON.stringify(verified.map((item) => item.sourceId))) {
    throw new InventoryError("Imported and Shopify variant identities no longer match. Review before enrolling.");
  }
  const existing = await db.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId } } });
  if (existing) {
    if (existing.productId !== claim.productId || existing.locationId !== location) throw new InventoryError("Saved inventory mapping changed; operator review is required.");
    verifyMappings(mappings(JSON.parse(existing.mappings)), current);
    if (existing.status === "RUNNING") throw new InventoryError("An inventory cycle is already running. Pause it before changing enrollment.");
  }
  const expired = Boolean(existing?.pendingAt && Date.now() - existing.pendingAt.getTime() >= 24 * 60 * 60 * 1000);
  if (expired) console.warn("Explicitly restarting inventory enrollment after an expired uncertain correction.", supplierId);
  await db.inventorySync.upsert({
    where: { shop_supplierId: { shop, supplierId } },
    create: { shop, supplierId, productId: claim.productId, locationId: location, mappings: JSON.stringify(verified),
      enabled: true, status: "QUEUED", nextRunAt: new Date() },
    update: { enabled: true, status: "QUEUED", revision: { increment: 1 }, nextRunAt: new Date(),
      ...(expired ? { pending: null, pendingKey: null, pendingAt: null } : {}) },
  });
}

export async function runInventoryCycle(shop: string, supplierId: number, api: GraphQL, stopping = () => false) {
  assertLabShop(shop);
  const claimed = await db.inventorySync.updateMany({
    where: { shop, supplierId, enabled: true, status: { not: "RUNNING" }, nextRunAt: { lte: new Date() } },
    data: { status: "RUNNING", nextRunAt: new Date(Date.now() + INVENTORY_INTERVAL) },
  });
  if (claimed.count !== 1) return;
  const saved = await db.inventorySync.findUniqueOrThrow({ where: { shop_supplierId: { shop, supplierId } } });
  if (!saved.enabled || saved.status !== "RUNNING") return;
  try {
    if (await shopContext(api, shop) !== saved.locationId) throw new InventoryError("Approved stock location changed. No inventory was updated.");
    const expected = mappings(JSON.parse(saved.mappings));
    let current = await remoteInventory(api, saved.productId, supplierId, saved.locationId);
    verifyMappings(expected, current);
    const allowed = async () => !stopping() && Boolean(await db.inventorySync.findFirst({
      where: { shop, supplierId, enabled: true, revision: saved.revision, status: "RUNNING" },
      select: { supplierId: true },
    }));
    const assertOperation = (input: StockOperation) => {
      if (input.quantities.some((item) => item.locationId !== saved.locationId ||
          !expected.some((mapping) => mapping.inventoryItemId === item.inventoryItemId))) {
        throw new InventoryError("Pending inventory correction is outside the approved mapping.");
      }
    };
    const apply = async (input: StockOperation, key: string) => {
      assertOperation(input);
      if (!await allowed()) return false;
      try {
        await setStock(api, input, key);
      } catch (error) {
        if (error instanceof InventoryMutationError) {
          await db.inventorySync.updateMany({ where: { shop, supplierId, pendingKey: key }, data: { pending: null, pendingKey: null, pendingAt: null } });
        }
        throw error;
      }
      await db.inventorySync.updateMany({ where: { shop, supplierId, pendingKey: key }, data: { pending: null, pendingKey: null, pendingAt: null } });
      return true;
    };
    if (saved.pending !== null || saved.pendingKey !== null) {
      if (!saved.pending || !saved.pendingKey || !saved.pendingAt) throw new InventoryError("Incomplete persisted inventory correction; operator review is required.");
      if (Date.now() - saved.pendingAt.getTime() >= 24 * 60 * 60 * 1000) {
        console.error("Uncertain inventory correction outlived Shopify's idempotency window.", supplierId);
        await db.inventorySync.updateMany({
          where: { shop, supplierId, enabled: true, revision: saved.revision, status: "RUNNING" },
          data: { enabled: false, status: "REVIEW",
            error: "An uncertain stock correction exceeded Shopify's 24-hour retry window. Review Shopify stock, then explicitly enable sync to start a fresh correction." },
        });
        return;
      }
      const pending = stockOperation(JSON.parse(saved.pending));
      assertOperation(pending);
      if (pending.quantities.every((quantity) =>
        current.find((item) => item.inventoryItemId === quantity.inventoryItemId)?.onHand === quantity.quantity)) {
        if (!await allowed()) return;
        await db.inventorySync.updateMany({ where: { shop, supplierId, pendingKey: saved.pendingKey },
          data: { pending: null, pendingKey: null, pendingAt: null } });
      } else if (!await apply(pending, saved.pendingKey)) return;
      current = await remoteInventory(api, saved.productId, supplierId, saved.locationId);
      verifyMappings(expected, current);
    }
    if (!await allowed()) return;
    const previous = saved.generation === null && saved.cursor === null ? null : checkpoint({ generation: saved.generation, cursor: saved.cursor });
    const feed = inventoryFeed(await inventoryState(supplierId, previous), supplierId, previous);
    const plan = stockPlan(current, feed, saved.locationId);
    for (let offset = 0; offset < plan.changed.length; offset += 250) {
      const key = randomBytes(16).toString("hex");
      const input: StockOperation = { name: "on_hand", reason: "correction",
        referenceDocumentUri: `gid://ultralove/InventorySync/${key}`, quantities: plan.changed.slice(offset, offset + 250) };
      if (stopping()) return;
      const reserved = await db.inventorySync.updateMany({
        where: { shop, supplierId, enabled: true, revision: saved.revision, status: "RUNNING", pending: null, pendingKey: null },
        data: { pending: JSON.stringify(input), pendingKey: key, pendingAt: new Date() },
      });
      if (reserved.count !== 1 || !await apply(input, key)) return;
    }
    if (!await allowed()) return;
    const verified = await remoteInventory(api, saved.productId, supplierId, saved.locationId);
    verifyMappings(expected, verified);
    if (plan.desired.some((quantity) => verified.find((item) => item.inventoryItemId === quantity.inventoryItemId)?.onHand !== quantity.quantity)) {
      throw new InventoryError("Shopify on-hand stock changed during verification. The checkpoint was not advanced; the next cycle will reconcile.");
    }
    await db.inventorySync.updateMany({
      where: { shop, supplierId, enabled: true, revision: saved.revision, status: "RUNNING" },
      data: { generation: feed.generation, cursor: feed.cursor, lastSuccessAt: new Date(),
        status: plan.warnings.length ? "REVIEW" : "SYNCED", error: plan.warnings.join(" ") || null },
    });
  } catch (error) {
    console.error("Inventory synchronization failed.", supplierId, error instanceof Error ? error.message : "Unknown failure");
    await db.inventorySync.updateMany({
      where: { shop, supplierId, enabled: true, revision: saved.revision, status: "RUNNING" },
      data: { status: error instanceof InventoryProductMissingError ? "REVIEW" : "FAILED",
        ...(error instanceof InventoryProductMissingError ? { enabled: false } : {}),
        ...(error instanceof CatalogError && error.retryAfter !== null
          ? { nextRunAt: new Date(Date.now() + Math.max(INVENTORY_INTERVAL, error.retryAfter * 1000)) } : {}),
        error: error instanceof InventoryError || error instanceof CatalogError ? error.message
        : "Inventory sync was interrupted or supplier/Shopify access failed. The next cycle retries; no checkpoint was advanced." },
    });
  } finally {
    await db.inventorySync.updateMany({
      where: { shop, supplierId, enabled: true, revision: saved.revision, status: "RUNNING" },
      data: { status: "QUEUED" },
    });
  }
}
