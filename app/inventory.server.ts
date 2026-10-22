import { randomBytes } from "node:crypto";
import type { InventorySync } from "@prisma/client";
import db from "./db.server";
import { assertLabShop } from "./lab-policy.server";
import { CatalogError, inventoryStates } from "./catalog.server";
import { payload, shopContext } from "./import-engine";
import type { GraphQL } from "./import-engine";
import {
  CHECKED_KEY, CHECKED_NAMESPACE, checkpoint, INVENTORY_CHECKED_MUTATION, INVENTORY_INTERVAL, INVENTORY_PRODUCT_BATCH_SIZE, inventoryFeed, InventoryError, InventoryMutationError, InventoryProductMissingError,
  mappings, remoteInventory, remoteInventories, setStock, stockOperation, stockPlan, verifyMappings,
} from "./inventory-engine";
import type { InventoryFeed, InventoryRead, Mapping, RemoteInventory, StockOperation } from "./inventory-engine";
import { fulfillmentMode } from "./fulfillment-policy";
import { markListingDeleted } from "./listing-lifecycle.server";
import { markupPercent } from "./pricing-policy";
import { feedVersionGate } from "./feed-version.server";

export async function inventoryScreen(shop: string) {
  assertLabShop(shop);
  const [claims, items, states] = await Promise.all([
    db.importClaim.findMany({ where: { shop, productId: { not: null } }, orderBy: { supplierId: "asc" } }),
    db.importItem.findMany({ where: { job: { shop }, status: { in: ["CREATED", "REUSED", "UPDATED", "LINKED"] }, productId: { not: null } },
      orderBy: { job: { createdAt: "desc" } }, select: { supplierId: true, productId: true, name: true, sku: true,
        job: { select: { markup: true, markups: true } } } }),
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
      fulfillmentMode: fulfillmentMode(claim.fulfillmentMode),
      deletedAt: claim.deletedAt?.toISOString() || null,
      markup: markupPercent(JSON.parse(item.job.markups)[claim.supplierId] ?? item.job.markup),
      enabled: !claim.deletedAt && (state?.enabled || false), status: claim.deletedAt ? "DELETED" : state?.status || "NOT_ENROLLED",
      error: state?.error || null, variantCount: state ? mappings(JSON.parse(state.mappings)).length : null,
      lastSuccessAt: state?.lastSuccessAt?.toISOString() || null,
      nextRunAt: !claim.deletedAt && state?.enabled ? state.nextRunAt.toISOString() : null,
    }];
  });
}

export async function inventoryControl(shop: string, supplierId: number, intent: string, api: GraphQL, confirmation?: string) {
  assertLabShop(shop);
  if (!Number.isInteger(supplierId) || supplierId < 1 || supplierId > 2147483647) throw new InventoryError("Invalid supplier inventory product.");
  if (intent !== "pause") {
    const claim = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId } } });
    if (claim && fulfillmentMode(claim.fulfillmentMode) === "CATALOG") {
      throw new InventoryError("Catalog-only inventory is retailer-managed. Review a dropshipping-mode import before enabling supplier sync.");
    }
  }
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
  await enableInventory(shop, supplierId, api);
}

async function enableInventory(shop: string, supplierId: number, api: GraphQL,
  preflight?: { location: string; productId: string; current: RemoteInventory[] }) {
  const claim = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId } } });
  if (!claim?.productId) throw new InventoryError("Import this product through the app before enabling inventory sync.");
  if (fulfillmentMode(claim.fulfillmentMode) !== "DROPSHIPPING") throw new InventoryError("Catalog-only products cannot enroll in supplier inventory sync.");
  const productId = claim.productId;
  const imported = await db.importItem.findFirst({
    where: { supplierId, productId: claim.productId, status: { in: ["CREATED", "REUSED", "UPDATED", "LINKED"] }, job: { shop } },
    orderBy: { job: { createdAt: "desc" } }, include: { job: true },
  });
  if (!imported) throw new InventoryError("A verified completed import is required before inventory enrollment.");
  const location = preflight?.location ?? await shopContext(api, shop);
  if (location !== imported.job.locationId) throw new InventoryError("The approved inventory location changed. Review the imported product.");
  const input = payload(JSON.parse(imported.payload), supplierId, imported.jobId, location);
  const sources = input.variants.map((variant) => Number(variant.metafields.find((field) =>
    field.namespace === "ultralove_catalog" && field.key === "supplier_id")?.value)).sort((a, b) => a - b);
  if (preflight && preflight.productId !== claim.productId) throw new InventoryError("The imported listing changed during enrollment. Refresh and review it.");
  let current: RemoteInventory[];
  try { current = preflight?.current ?? await remoteInventory(api, claim.productId, supplierId, location); }
  catch (error) {
    if (error instanceof InventoryProductMissingError) await markListingDeleted(shop, claim.productId);
    throw error;
  }
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
  if (preflight && existing && (existing.pending !== null || existing.pendingKey !== null || existing.pendingAt !== null)) {
    throw new InventoryError("A pending stock correction needs individual review. Bulk enrollment does not reset or resume uncertain corrections.");
  }
  if (expired && existing?.pendingKey && (pendingCorrection(existing).ids.length > 1 ||
      await db.inventorySync.count({ where: { shop, pendingKey: existing.pendingKey } }) > 1)) {
    throw new InventoryError("An expired cross-product stock correction needs operator review for every participating product. Its shared retry record was not reset.");
  }
  if (expired) console.warn("Explicitly restarting inventory enrollment after an expired uncertain correction.", supplierId);
  await db.$transaction(async (transaction) => {
    const latestClaim = await transaction.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId } } });
    if (latestClaim?.productId !== claim.productId || latestClaim.fulfillmentMode !== "DROPSHIPPING") throw new InventoryError("The imported listing or fulfillment mode changed during enrollment. Refresh and review it.");
    if (latestClaim.deletedAt?.getTime() !== claim.deletedAt?.getTime()) throw new InventoryError("The Shopify listing was deleted during enrollment. Refresh and review recovery.");
    if (existing) {
      const updated = await transaction.inventorySync.updateMany({
        where: { shop, supplierId, revision: existing.revision, status: { not: "RUNNING" },
          pending: existing.pending, pendingKey: existing.pendingKey },
        data: { enabled: true, status: "QUEUED", error: null, revision: { increment: 1 }, nextRunAt: new Date(),
          ...(expired ? { pending: null, pendingKey: null, pendingAt: null } : {}) },
      });
      if (updated.count !== 1) throw new InventoryError("Inventory enrollment changed during verification. Refresh its status before retrying.");
    } else {
      await transaction.inventorySync.create({ data: { shop, supplierId, productId, locationId: location,
        mappings: JSON.stringify(verified), enabled: true, status: "QUEUED", nextRunAt: new Date() } });
    }
    await transaction.importClaim.update({ where: { shop_supplierId: { shop, supplierId } },
      data: { deletedAt: null, listingCheckedAt: new Date() } });
  });
}

export async function enableAllInventory(shop: string, api: GraphQL, confirmation: string) {
  assertLabShop(shop);
  if (confirmation !== "inventory-all-current") throw new InventoryError("Confirm inventory-only sync for all currently imported eligible products.");
  const products = (await inventoryScreen(shop)).filter((product) => !product.deletedAt);
  const result = { total: products.length, enabled: 0, alreadyEnabled: 0, error: null as string | null,
    blocked: [] as { supplierId: number; name: string; sku: string; error: string }[] };
  const candidates: ((typeof products)[number] & { productId: string })[] = [];
  for (const product of products) {
    if (product.fulfillmentMode === "CATALOG") {
      result.blocked.push({ ...product, error: "Catalog only: your own stock is never eligible for supplier sync." });
    } else if (product.enabled) {
      result.alreadyEnabled++;
    } else if (product.status === "RUNNING" || !product.productId) {
      result.blocked.push({ ...product, error: "A verified, non-running imported listing is required. Refresh its status." });
    } else {
      candidates.push({ ...product, productId: product.productId });
    }
  }
  if (!candidates.length) return result;
  const interrupted = (offset: number, error: unknown) => {
    console.error("Bulk inventory enrollment interrupted.", error instanceof Error ? error.message : "Unknown failure");
    result.error = error instanceof InventoryError ? error.message
      : "Bulk enrollment stopped because Shopify or saved inventory verification failed. Previously enabled products stay enabled; review the results before retrying.";
    for (const product of candidates.slice(offset)) result.blocked.push({
      supplierId: product.supplierId, name: product.name, sku: product.sku, error: `Not enabled: ${result.error}`,
    });
    return result;
  };
  let location: string;
  try { location = await shopContext(api, shop); } catch (error) { return interrupted(0, error); }
  for (let offset = 0; offset < candidates.length; offset += INVENTORY_PRODUCT_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + INVENTORY_PRODUCT_BATCH_SIZE);
    let reads: InventoryRead[];
    try { reads = await remoteInventories(api, batch, location); } catch (error) { return interrupted(offset, error); }
    for (const [index, read] of reads.entries()) {
      const product = batch[index];
      try {
        if ("error" in read) throw read.error;
        await enableInventory(shop, product.supplierId, api, { location, productId: product.productId, current: read.inventory });
        result.enabled++;
      } catch (error) {
        if (!(error instanceof InventoryError)) return interrupted(offset + index, error);
        if (error instanceof InventoryProductMissingError) await markListingDeleted(shop, product.productId);
        console.warn("Bulk inventory enrollment rejected.", product.supplierId, error.message);
        result.blocked.push({ supplierId: product.supplierId, name: product.name, sku: product.sku, error: error.message });
      }
    }
  }
  return result;
}

type InventoryWork = {
  saved: InventorySync; claimed: boolean; failed: boolean; expected: Mapping[];
  current: RemoteInventory[] | null; feed: InventoryFeed | null; plan: ReturnType<typeof stockPlan> | null;
};

function pendingCorrection(saved: InventorySync) {
  if (!saved.pending || !saved.pendingKey || !saved.pendingAt) {
    throw new InventoryError("Incomplete persisted inventory correction; operator review is required.");
  }
  let value: unknown;
  try { value = JSON.parse(saved.pending); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new InventoryError("The persisted inventory correction is not valid JSON; operator review is required.");
  }
  const input = stockOperation(value);
  if (!/^[a-f0-9]{32}$/.test(saved.pendingKey) ||
      input.referenceDocumentUri !== `gid://ultralove/InventorySync/${saved.pendingKey}`) {
    throw new InventoryError("The persisted inventory correction key and request identity do not match; operator review is required.");
  }
  const ids = typeof value === "object" && value !== null && "participants" in value ? value.participants : [saved.supplierId];
  if (!Array.isArray(ids) || !ids.length || ids.length > INVENTORY_PRODUCT_BATCH_SIZE ||
      ids.some((id) => typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 2147483647) ||
      new Set(ids).size !== ids.length || !ids.includes(saved.supplierId)) {
    throw new InventoryError("Invalid persisted stock correction participants; operator review is required.");
  }
  return { ids: ids.sort((a, b) => a - b), key: saved.pendingKey, pendingAt: saved.pendingAt, input };
}

export async function runInventoryCycle(shop: string, supplierId: number, api: GraphQL, stopping = () => false) {
  return runInventoryBatch(shop, [supplierId], api, stopping);
}

export async function runInventoryBatch(shop: string, supplierIds: number[], api: GraphQL, stopping = () => false) {
  assertLabShop(shop);
  if (!supplierIds.length || supplierIds.length > INVENTORY_PRODUCT_BATCH_SIZE ||
      supplierIds.some((id) => !Number.isInteger(id) || id < 1 || id > 2147483647) ||
      new Set(supplierIds).size !== supplierIds.length) throw new InventoryError("Schedule 1-5 distinct inventory products per cycle.");
  // An unsupported supplier feed schema pauses every product, like the Settings pause: nothing is claimed.
  if (!(await feedVersionGate("inventory")).allowed) return;
  const work: InventoryWork[] = [];
  const guard = (item: InventoryWork) => ({
    shop, supplierId: item.saved.supplierId, enabled: true, revision: item.saved.revision, status: "RUNNING",
  });
  const claim = async (saved: InventorySync, due: boolean) => {
    const owner = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: saved.supplierId } } });
    if (!owner || owner.deletedAt || owner.productId !== saved.productId || owner.fulfillmentMode !== "DROPSHIPPING") {
      console.warn("Supplier inventory cycle blocked by fulfillment ownership.", saved.supplierId);
      await db.inventorySync.updateMany({ where: { shop, supplierId: saved.supplierId, revision: saved.revision },
        data: { enabled: false, status: "REVIEW", revision: { increment: 1 }, error: "Supplier sync is not authorized for this product's fulfillment mode or listing." } });
      return;
    }
    const nextRunAt = new Date(Date.now() + INVENTORY_INTERVAL);
    const claimed = saved.enabled && saved.status !== "RUNNING" && (await db.inventorySync.updateMany({
      where: { shop, supplierId: saved.supplierId, enabled: true, revision: saved.revision, status: { not: "RUNNING" },
        ...(due ? { nextRunAt: { lte: new Date() } } : {}) },
      data: { status: "RUNNING", nextRunAt },
    })).count === 1;
    const item: InventoryWork = { saved: claimed ? { ...saved, status: "RUNNING", nextRunAt } : saved,
      claimed, failed: false, expected: [], current: null, feed: null, plan: null };
    if (claimed || !due) work.push(item);
  };
  for (const supplierId of supplierIds) {
    const saved = await db.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId } } });
    if (saved) await claim(saved, true);
  }
  if (!work.length) return;
  const allowed = async (item: InventoryWork) => item.claimed && !item.failed && !stopping() &&
    Boolean(await db.inventorySync.findFirst({ where: guard(item), select: { supplierId: true } })) &&
    Boolean(await db.importClaim.findFirst({ where: { shop, supplierId: item.saved.supplierId,
      productId: item.saved.productId, fulfillmentMode: "DROPSHIPPING", deletedAt: null }, select: { supplierId: true } }));
  const fail = async (item: InventoryWork, error: unknown, review = false, disable = false) => {
    item.failed = true;
    console.error("Inventory synchronization failed.", item.saved.supplierId, error instanceof Error ? error.message : "Unknown failure");
    if (error instanceof InventoryProductMissingError) await markListingDeleted(shop, item.saved.productId);
    if (!item.claimed) return;
    await db.inventorySync.updateMany({
      where: guard(item),
      data: { status: review || error instanceof InventoryProductMissingError ? "REVIEW" : "FAILED",
        ...(disable || error instanceof InventoryProductMissingError ? { enabled: false } : {}),
        ...(error instanceof CatalogError && error.retryAfter !== null
          ? { nextRunAt: new Date(Date.now() + Math.max(INVENTORY_INTERVAL, error.retryAfter * 1000)) } : {}),
        error: error instanceof InventoryError || error instanceof CatalogError ? error.message
          : "Inventory sync was interrupted or supplier/Shopify access failed. The next cycle retries; no checkpoint was advanced." },
    });
  };
  const clear = async (members: InventoryWork[], key: string) => {
    await db.inventorySync.updateMany({ where: { shop, supplierId: { in: members.map((item) => item.saved.supplierId) }, pendingKey: key },
      data: { pending: null, pendingKey: null, pendingAt: null } });
    for (const item of members) Object.assign(item.saved, { pending: null, pendingKey: null, pendingAt: null });
  };
  const apply = async (members: InventoryWork[], input: StockOperation, key: string) => {
    for (const quantity of input.quantities) {
      const owners = members.filter((item) => item.saved.locationId === quantity.locationId &&
        item.expected.some((mapping) => mapping.inventoryItemId === quantity.inventoryItemId));
      if (owners.length !== 1) throw new InventoryError("Pending inventory correction is outside the uniquely approved product mappings.");
    }
    if (!(await Promise.all(members.map(allowed))).every(Boolean)) return false;
    try {
      await setStock(api, input, key);
    } catch (error) {
      if (error instanceof InventoryMutationError) await clear(members, key);
      throw error;
    }
    await clear(members, key);
    return true;
  };
  const read = async (items: InventoryWork[], location: string) => {
    for (let offset = 0; offset < items.length; offset += INVENTORY_PRODUCT_BATCH_SIZE) {
      const batch = items.slice(offset, offset + INVENTORY_PRODUCT_BATCH_SIZE);
      try {
        const reads = await remoteInventories(api, batch.map((item) => ({
          supplierId: item.saved.supplierId, productId: item.saved.productId,
        })), location);
        for (const [index, result] of reads.entries()) {
          const item = batch[index];
          try {
            if ("error" in result) throw result.error;
            item.expected = mappings(JSON.parse(item.saved.mappings));
            verifyMappings(item.expected, result.inventory);
            item.current = result.inventory;
          } catch (error) { await fail(item, error); }
        }
      } catch (error) { for (const item of batch) await fail(item, error); }
    }
  };
  try {
    const pendingGroups = new Map<string, { members: InventoryWork[]; input: StockOperation }>();
    const seen = new Set<string>();
    for (let index = 0; index < work.length; index++) {
      const item = work[index];
      const key = item.saved.pendingKey;
      if (item.saved.pending === null && key === null && item.saved.pendingAt === null) continue;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      try {
        const correction = pendingCorrection(item.saved);
        const { ids } = correction;
        const rows = await db.inventorySync.findMany({ where: { shop, pendingKey: correction.key } });
        if (rows.length !== ids.length || rows.some((row) => !ids.includes(row.supplierId) ||
            row.pending !== item.saved.pending || row.pendingAt?.getTime() !== item.saved.pendingAt?.getTime())) {
          throw new InventoryError("Shared inventory correction records are incomplete or inconsistent; operator review is required.");
        }
        for (const row of rows) if (!work.some((entry) => entry.saved.supplierId === row.supplierId)) await claim(row, false);
        const members = work.filter((entry) => ids.includes(entry.saved.supplierId));
        if (Date.now() - correction.pendingAt.getTime() >= 24 * 60 * 60 * 1000) {
          const error = new InventoryError(ids.length > 1
            ? "An uncertain cross-product stock correction exceeded Shopify's 24-hour retry window. Operator review is required for all participating products; the shared correction remains protected."
            : "An uncertain stock correction exceeded Shopify's 24-hour retry window. Review Shopify stock, then explicitly enable sync to start a fresh correction.");
          for (const member of members) await fail(member, error, true, true);
        } else {
          pendingGroups.set(correction.key, { members, input: correction.input });
        }
      } catch (error) {
        for (const member of work.filter((entry) => entry === item || key !== null && entry.saved.pendingKey === key)) await fail(member, error, true);
      }
    }
    if (stopping() || work.every((item) => item.failed)) return;
    const location = await shopContext(api, shop);
    for (const item of work) if (!item.failed && item.saved.locationId !== location) {
      await fail(item, new InventoryError("Approved stock location changed. No inventory was updated."));
    }
    await read(work.filter((item) => !item.failed), location);
    for (const [key, { members, input }] of pendingGroups) {
      try {
        if (members.some((item) => item.failed || !item.current)) {
          throw new InventoryError("A participating product could not be verified. Its shared stock correction remains protected; review every participating listing before retrying.");
        }
        if (input.quantities.some((quantity) => members.filter((item) => item.saved.locationId === quantity.locationId &&
            item.expected.some((mapping) => mapping.inventoryItemId === quantity.inventoryItemId)).length !== 1)) {
          throw new InventoryError("Pending inventory correction is outside the uniquely approved product mappings.");
        }
        if (input.quantities.every((quantity) => members.some((item) =>
            item.current?.some((remote) => remote.inventoryItemId === quantity.inventoryItemId && remote.onHand === quantity.quantity)))) {
          if (stopping()) return;
          await clear(members, key);
        } else {
          if (!await apply(members, input, key)) {
            throw new InventoryError("A participating product is paused or its enrollment changed. Resume and verify every participating product before retrying the protected shared correction.");
          }
          await read(members, location);
        }
      } catch (error) {
        for (const member of members) if (!member.failed) await fail(member, error, true);
      }
    }
    const ready: InventoryWork[] = [];
    for (const item of work) if (item.current && item.saved.pending === null && await allowed(item)) ready.push(item);
    for (let offset = 0; offset < ready.length; offset += INVENTORY_PRODUCT_BATCH_SIZE) {
      const batch = ready.slice(offset, offset + INVENTORY_PRODUCT_BATCH_SIZE);
      try {
        const requests = batch.map((item) => ({ supplierId: item.saved.supplierId,
          checkpoint: item.saved.generation === null && item.saved.cursor === null ? null
            : checkpoint({ generation: item.saved.generation, cursor: item.saved.cursor }) }));
        const feeds = await inventoryStates(requests);
        for (const [index, item] of batch.entries()) {
          try {
            item.feed = inventoryFeed(feeds[index], item.saved.supplierId, requests[index].checkpoint);
            if (!item.current) throw new InventoryError("Shopify inventory was not verified before reading supplier stock.");
            item.plan = stockPlan(item.current, item.feed, location);
          } catch (error) { await fail(item, error); }
        }
      } catch (error) { for (const item of batch) await fail(item, error); }
    }
    for (let productOffset = 0; productOffset < ready.length; productOffset += INVENTORY_PRODUCT_BATCH_SIZE) {
      const parents = ready.slice(productOffset, productOffset + INVENTORY_PRODUCT_BATCH_SIZE);
      const changes = parents.flatMap((item) => item.failed || !item.plan ? [] : item.plan.changed.map((quantity) => ({ item, quantity })));
      for (let offset = 0; offset < changes.length; offset += 250) {
        if (stopping()) return;
        const candidates = changes.slice(offset, offset + 250).filter((entry) => !entry.item.failed);
        const active = new Set<InventoryWork>();
        for (const item of new Set(candidates.map((entry) => entry.item))) if (await allowed(item)) active.add(item);
        const entries = candidates.filter((entry) => active.has(entry.item));
        if (!entries.length) continue;
        const members = [...active];
        try {
          const key = randomBytes(16).toString("hex");
          const input = stockOperation({ name: "on_hand", reason: "correction",
            referenceDocumentUri: `gid://ultralove/InventorySync/${key}`, quantities: entries.map((entry) => entry.quantity) });
          const pending = JSON.stringify({ ...input, participants: members.map((item) => item.saved.supplierId).sort((a, b) => a - b) });
          const pendingAt = new Date();
          await db.$transaction(async (transaction) => {
            for (const member of members) {
              const reserved = await transaction.inventorySync.updateMany({ where: { ...guard(member), pending: null, pendingKey: null },
                data: { pending, pendingKey: key, pendingAt } });
              if (reserved.count !== 1) throw new InventoryError("Inventory enrollment changed while reserving the batch; no stock correction was sent.");
            }
          });
          for (const member of members) Object.assign(member.saved, { pending, pendingKey: key, pendingAt });
          if (!await apply(members, input, key)) {
            throw new InventoryError("Inventory enrollment changed after the batch was reserved. The shared correction remains protected; no stock request was sent.");
          }
        } catch (error) { for (const member of members) await fail(member, error); }
      }
    }
    const verify: InventoryWork[] = [];
    const checked: Record<string, string>[] = [];
    for (const item of ready) if (item.plan && item.feed && await allowed(item)) verify.push(item);
    await read(verify, location);
    for (const item of verify) {
      if (!item.current || !item.plan || !item.feed || !await allowed(item)) continue;
      if (item.plan.desired.some((quantity) => !item.current?.some((remote) =>
          remote.inventoryItemId === quantity.inventoryItemId && remote.onHand === quantity.quantity))) {
        await fail(item, new InventoryError("Shopify on-hand stock changed during verification. The checkpoint was not advanced; the next cycle will reconcile."));
        continue;
      }
      const checkedAt = new Date();
      await db.inventorySync.updateMany({ where: guard(item), data: { generation: item.feed.generation, cursor: item.feed.cursor,
        lastSuccessAt: checkedAt, status: item.plan.warnings.length ? "REVIEW" : "SYNCED", error: item.plan.warnings.join(" ") || null } });
      checked.push({ ownerId: item.saved.productId, namespace: CHECKED_NAMESPACE, key: CHECKED_KEY, type: "date_time",
        value: checkedAt.toISOString() });
    }
    // Stock is already verified and saved, so a failed write here only leaves the product page's "last checked" time stale.
    for (let offset = 0; offset < checked.length; offset += 25) {
      await api(INVENTORY_CHECKED_MUTATION, { metafields: checked.slice(offset, offset + 25) }).catch(() => null);
    }
  } catch (error) {
    for (const item of work) if (!item.failed) await fail(item, error);
  } finally {
    for (const item of work) if (item.claimed) await db.inventorySync.updateMany({ where: guard(item), data: { status: "QUEUED" } });
  }
}
