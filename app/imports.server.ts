import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import db from "./db.server";
import { CATALOG_BATCH_SIZE, selectionIds } from "./catalog-policy";
import { importPlan, validateSelection } from "./catalog.server";
import { assertShopDomain } from "./shop-policy.server";
import { feedVersionGate } from "./feed-version.server";
import { ImportError, MAX_PREVIEW_AGE, catalogOnlyPayload, importConfirmation, importDraft, importSettings, markupPercent, matchProduct, onlineStorePublication, ownedProduct, payload, plannedFeed, priceRange, remoteCatalog, reviewLabels, shopContext } from "./import-engine";
import type { GraphQL } from "./import-engine";
import { markupOverrides, retailPrice } from "./pricing-policy";
import type { MarkupOverrides } from "./pricing-policy";
import { defaultListingPolicy, listingPolicy, listingSignature } from "./listing-policy";
import type { ListingPolicy } from "./listing-policy";
import { applyListing, assertLinkOwnership, listedVariants, listingChanges, listingSnapshot, matchListingVariants, supplierVariantIds } from "./listing-engine";
import type { ListingReview, ListingWork } from "./listing-engine";
import { fulfillmentMode, fulfillmentModes, modeFor } from "./fulfillment-policy";
import type { FulfillmentModes } from "./fulfillment-policy";

const completed = ["CREATED", "REUSED", "UPDATED", "LINKED"];
function listingConfirmation(active: boolean, publicationId: string | null, policy: ListingPolicy,
  items: { supplierId: number; fulfillmentMode: string }[] = []) {
  const base = importConfirmation(importSettings(active, publicationId));
  const listing = listingSignature(policy) === listingSignature(defaultListingPolicy()) ? base
    : `${base}:listing:${createHash("sha256").update(listingSignature(policy)).digest("hex")}`;
  return items.some((item) => fulfillmentMode(item.fulfillmentMode) === "CATALOG")
    ? `${listing}:fulfillment:${createHash("sha256").update(JSON.stringify(items.map((item) =>
      [item.supplierId, fulfillmentMode(item.fulfillmentMode)]).sort((a, b) => Number(a[0]) - Number(b[0])))).digest("hex")}`
    : listing;
}
function review(value: string, productId: string | null): ListingReview {
  const saved = JSON.parse(value);
  return saved.action ? saved : { action: productId ? "KEEP" : "CREATE", targetId: productId, changes: [], message: null };
}

async function checkTargetClaims(shop: string, supplierId: number, productId: string) {
  const [claim, binding, imported] = await Promise.all([
    db.importClaim.findFirst({ where: { productId, NOT: { shop, supplierId } } }),
    db.inventorySync.findFirst({ where: { productId, NOT: { shop, supplierId } } }),
    db.importItem.findFirst({ where: { productId, OR: [{ supplierId: { not: supplierId } }, { job: { shop: { not: shop } } }] } }),
  ]);
  if (claim || binding || imported) throw new ImportError("Link target is claimed or enrolled by another supplier/store; no listing was changed.");
}

export async function savedConfiguration(shop: string) {
  assertShopDomain(shop);
  const saved = await db.catalogSelection.findUnique({ where: { shop } });
  const selected = selectionIds(saved ? JSON.parse(saved.productIds) : []);
  return { selected, markup: markupPercent(saved?.markup ?? "0"),
    markups: markupOverrides(JSON.parse(saved?.markups ?? "{}"), selected),
    fulfillmentModes: fulfillmentModes(JSON.parse(saved?.fulfillmentModes ?? "{}"), selected) };
}

export async function savedSelection(shop: string) {
  return (await savedConfiguration(shop)).selected;
}

export async function createPreview(shop: string, markup: string, api: GraphQL, choices = { active: false, publish: false },
  configuration?: { ids: number[]; markups: MarkupOverrides; fulfillmentModes?: FulfillmentModes }, requestedPolicy?: ListingPolicy) {
  assertShopDomain(shop);
  if (typeof choices.active !== "boolean" || typeof choices.publish !== "boolean" || (choices.publish && !choices.active)) {
    throw new ImportError("Publishing requires a valid Active import setting.");
  }
  const ids = configuration ? selectionIds(configuration.ids) : await savedSelection(shop);
  if (!ids.length) throw new ImportError("Select at least one parent product before reviewing pricing.");
  const policy = listingPolicy(requestedPolicy, ids);
  const normalized = markupPercent(markup);
  const overrides = markupOverrides(configuration?.markups ?? {}, ids);
  const modes = fulfillmentModes(configuration?.fulfillmentModes ?? (configuration ? {} : (await savedConfiguration(shop)).fulfillmentModes), ids);
  const location = await shopContext(api, shop);
  const settings = importSettings(choices.active, choices.publish ? await onlineStorePublication(api) : null);
  const version = await feedVersionGate("preview");
  if (!version.allowed) throw new ImportError(`${version.reason} Nothing was saved.`);
  const run = randomBytes(16).toString("hex");
  const first = ids.slice(0, CATALOG_BATCH_SIZE);
  const plan = plannedFeed(await importPlan(first, location, run, normalized), first, run, location);
  let cursor = plan.cursor;
  for (let offset = CATALOG_BATCH_SIZE; offset < ids.length; offset += CATALOG_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + CATALOG_BATCH_SIZE);
    const next = plannedFeed(await importPlan(batch, location, run, normalized), batch, run, location);
    if (next.generation !== plan.generation || next.cursor < cursor) {
      throw new ImportError("Supplier feed changed while planning the selection. Create a fresh preview; nothing was saved.");
    }
    cursor = next.cursor;
    plan.items.push(...next.items);
  }
  for (const item of plan.items) {
    if (modeFor(modes, item.supplierId) === "CATALOG") item.payload = catalogOnlyPayload(item.payload);
    if (overrides[item.supplierId] !== undefined) {
      item.payload.variants = item.payload.variants.map((variant, index) => ({
        ...variant, price: retailPrice(item.wholesale[index], overrides[item.supplierId]),
      }));
    }
  }
  const products = await remoteCatalog(api);
  const reviews = new Map<number, { listing: ListingReview; work: ListingWork }>();
  for (const item of plan.items) {
    const claim = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
    const binding = await db.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
    const expected = claim?.productId || binding?.productId || null;
    const known = products.find((product) => product.id === expected);
    if (known && (known.supplierId?.value && known.supplierId.value !== String(item.supplierId) ||
        /^ultralove-catalog-[1-9]\d*$/.test(known.handle) && known.handle !== `ultralove-catalog-${item.supplierId}`)) {
      throw new ImportError("The mapped product is owned by another supplier. No listing was changed.");
    }
    const existing = matchProduct(known && !ownedProduct(known, item.supplierId)
      ? products.filter((product) => product.id !== expected) : products, item.supplierId);
    const target = policy.links[item.supplierId] || existing?.id || null;
    const work: ListingWork = { expectedProductId: expected, expectedClaimRun: claim?.runId || null, capturedAt: Date.now() };
    const listing: ListingReview = { action: target ? "KEEP" : "CREATE", targetId: target, changes: [], message: null };
    const block = (message: string) => { listing.action = "BLOCKED"; listing.message = message; };
    if (policy.links[item.supplierId] && existing && existing.id !== target) {
      throw new ImportError("A live supplier identity already exists on another listing. No link or replacement was applied.");
    }
    if (policy.recreate.includes(item.supplierId) ||
        (expected && !policy.links[item.supplierId] && (!target || target !== expected))) {
      listing.targetId = expected;
      if (!expected) block("A replacement requires a previously saved Shopify mapping.");
      else if (!claim?.productId || claim.productId !== expected) block("A replacement requires a certain saved creation mapping. Reconcile the previous import or reconnect an existing product.");
      else if (existing) block("A Shopify listing for this supplier still exists. Reconnect it instead of creating a replacement.");
      else if (await listingSnapshot(api, expected)) block("The previously linked Shopify product still exists, but its UltraLove connection changed. Reconnect it instead of creating a replacement.");
      else {
        listing.action = "RECREATE";
        listing.targetId = null;
        listing.message = "The previously linked product is confirmed missing. Confirming this review will create a new Shopify product using the reviewed prices and visibility settings. Product and variant IDs will change; previous retailer edits and collection membership are not restored.";
      }
    }
    if (listing.action === "RECREATE" || policy.links[item.supplierId]) {
      if (binding?.enabled || binding?.status === "RUNNING") block("Pause inventory synchronization before reconnecting or replacing this listing.");
      else if (binding?.pending) block("An uncertain inventory correction remains pending. Reconcile it before replacing the inventory binding.");
    }
    if (listing.action !== "BLOCKED" && claim && fulfillmentMode(claim.fulfillmentMode) !== modeFor(modes, item.supplierId)
        && (binding?.enabled || binding?.status === "RUNNING" || binding?.pending)) {
      block("Pause inventory sync and reconcile pending corrections before changing fulfillment mode. Retailer-managed inventory will not be overwritten.");
    }
    if (!["BLOCKED", "RECREATE"].includes(listing.action) && target &&
        (policy.mode === "UPDATE" || policy.links[item.supplierId])) {
      await checkTargetClaims(shop, item.supplierId, target);
      const snapshot = await listingSnapshot(api, target);
      if (!snapshot) block("The Shopify product disappeared while preparing this review. Create a fresh preview to verify a replacement, or reconnect an existing product.");
      else {
        assertLinkOwnership(snapshot, item.supplierId, expected);
        try {
          const listed = listedVariants(snapshot, item.payload);
          if (listed) {
            item.payload = { ...item.payload, variants: listed.keep.map((index) => item.payload.variants[index]) };
            item.wholesale = listed.keep.map((index) => item.wholesale[index]);
          }
          work.variantIds = matchListingVariants(snapshot, item.payload, Boolean(policy.links[item.supplierId]));
          work.baseline = snapshot;
          listing.action = policy.links[item.supplierId] ? "LINK" : "UPDATE";
          listing.changes = listingChanges(snapshot, item.payload, policy, work.variantIds);
          const notes = [];
          if (listing.action === "LINK") notes.push("Associate supplier identities without changing handles, SKUs, stock or publication. Only separately selected fields will be refreshed.");
          if (listed) notes.push(`Not on your Shopify listing, so left out: ${listed.missing.join(", ")}. Variants deleted in Shopify stay deleted, and the app can't add new UltraLove variants to an existing listing yet.`);
          if (notes.length) listing.message = notes.join(" ");
        } catch (error) {
          if (!(error instanceof ImportError)) throw error;
          block(error.message);
        }
      }
    }
    if (listing.action === "CREATE" || listing.action === "RECREATE") {
      try { supplierVariantIds(item.payload); } catch (error) {
        if (!(error instanceof ImportError)) throw error;
        block(error.message);
      }
      if (claim?.mutationStartedAt && !claim.productId) block("A previous creation may have reached Shopify. Reconcile the uncertain creation before another import.");
    }
    reviews.set(item.supplierId, { listing, work });
  }
  const input = {
    data: {
      id: run, shop, selection: JSON.stringify(ids), markup: normalized, markups: JSON.stringify(overrides), locationId: location,
      generation: plan.generation, cursor: plan.cursor,
      listingPolicy: listingSignature(policy),
      ...settings,
      items: { create: plan.items.map((item) => ({
        supplierId: item.supplierId, name: item.name, sku: item.sku,
        wholesale: JSON.stringify(item.wholesale), payload: JSON.stringify(item.payload),
        fulfillmentMode: modeFor(modes, item.supplierId),
        productId: reviews.get(item.supplierId)!.listing.targetId,
        listing: JSON.stringify(reviews.get(item.supplierId)!.listing),
        listingWork: JSON.stringify(reviews.get(item.supplierId)!.work),
      })) },
    },
  };
  if (!configuration) return db.importJob.create(input);
  return db.$transaction(async (transaction) => {
    await transaction.catalogSelection.upsert({
      where: { shop },
      create: { shop, productIds: JSON.stringify(ids), markup: normalized, markups: JSON.stringify(overrides), fulfillmentModes: JSON.stringify(modes) },
      update: { productIds: JSON.stringify(ids), markup: normalized, markups: JSON.stringify(overrides), fulfillmentModes: JSON.stringify(modes) },
    });
    return transaction.importJob.create(input);
  });
}

export async function queueJob(shop: string, id: string, retry: boolean, confirmation = "draft-only") {
  assertShopDomain(shop);
  const job = await db.importJob.findFirst({ where: { id, shop }, include: { items: true } });
  if (!job || job.status !== (retry ? "FAILED" : "PREVIEW")) throw new ImportError("This job cannot be queued in its current state.");
  const policy = listingPolicy(JSON.parse(job.listingPolicy), selectionIds(JSON.parse(job.selection)));
  if (confirmation !== listingConfirmation(job.active, job.publicationId, policy, job.items)) {
    throw new ImportError("Confirm the saved import visibility settings before queueing.");
  }
  if (job.items.some((item) => review(item.listing, item.productId).action === "BLOCKED")) {
    throw new ImportError("Resolve blocked listings and create a fresh preview. Verified missing products will be proposed as replacements; existing or uncertain listings require reconnection or reconciliation.");
  }
  if (!retry && Date.now() - job.createdAt.getTime() > MAX_PREVIEW_AGE) throw new ImportError("Pricing preview expired. Create a fresh preview.");
  if (!retry && JSON.stringify(await savedSelection(shop)) !== job.selection) throw new ImportError("Saved selections changed. Create a fresh pricing preview.");
  try {
    const updated = await db.importJob.updateMany({
      where: { id, shop, status: job.status, listingPolicy: job.listingPolicy },
      data: { status: "QUEUED", activeShop: shop, error: null },
    });
    if (updated.count !== 1) throw new ImportError("Another request changed this job. Refresh its status.");
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    throw new ImportError("Another import job is queued or running for this store. Wait for its result.");
  }
}

export async function importScreen(shop: string, id: string | null) {
  assertShopDomain(shop);
  const [configuration, history, current] = await Promise.all([
    savedConfiguration(shop),
    db.importJob.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 10,
      select: { id: true, status: true, markup: true, createdAt: true, items: { select: { status: true } } } }),
    id ? db.importJob.findFirst({ where: { id, shop }, include: { items: { orderBy: { supplierId: "asc" } } } }) : null,
  ]);
  if (id && !current) throw new Response("Import job not found.", { status: 404 });
  const overrides = current ? markupOverrides(JSON.parse(current.markups), selectionIds(JSON.parse(current.selection))) : {};
  const policy = current ? listingPolicy(JSON.parse(current.listingPolicy), selectionIds(JSON.parse(current.selection))) : defaultListingPolicy();
  const job = current && {
    id: current.id, status: current.status, markup: current.markup, createdAt: current.createdAt.toISOString(),
    markups: overrides,
    listingPolicy: policy,
    ...importSettings(current.active, current.publicationId),
    confirmation: listingConfirmation(current.active, current.publicationId, policy, current.items),
    error: current.error, generation: current.generation, cursor: current.cursor,
    items: current.items.map((item) => {
      const mode = fulfillmentMode(item.fulfillmentMode);
      const input = payload(JSON.parse(item.payload), item.supplierId, current.id, current.locationId, mode);
      return {
        fulfillmentMode: mode,
        supplierId: item.supplierId, name: item.name, sku: item.sku, status: item.status,
        listing: review(item.listing, item.productId),
        markup: overrides[item.supplierId] ?? current.markup,
        productId: item.productId, error: item.error, attempts: item.attempts,
        wholesale: priceRange(JSON.parse(item.wholesale)), retail: priceRange(input.variants.map((variant) => variant.price)),
        variantCount: input.variants.length, warnings: reviewLabels(input),
      };
    }),
  };
  return { ...configuration, job, history: history.map((entry) => ({
    id: entry.id, status: entry.status, markup: entry.markup, createdAt: entry.createdAt.toISOString(),
    completed: entry.items.filter((item) => completed.includes(item.status)).length,
    total: entry.items.length,
  })) };
}

export async function runJob(id: string, shop: string, api: GraphQL, stopping: () => boolean) {
  assertShopDomain(shop);
  const claimed = await db.importJob.updateMany({ where: { id, shop, status: "QUEUED" }, data: { status: "RUNNING" } });
  if (claimed.count !== 1) return;
  const job = await db.importJob.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { supplierId: "asc" } } } });
  try {
    const settings = importSettings(job.active, job.publicationId);
    const ids = selectionIds(JSON.parse(job.selection));
    const policy = listingPolicy(JSON.parse(job.listingPolicy), ids);
    if (!ids.length || ids.length !== job.items.length) throw new ImportError("Invalid immutable job selection.");
    if (await shopContext(api, shop) !== job.locationId) throw new ImportError("Approved inventory location changed. No new drafts were created.");
    if (settings.publicationId && await onlineStorePublication(api) !== settings.publicationId) {
      throw new ImportError("The Online Store publication changed since preview. Create a fresh preview; no new product was created or published.");
    }
    const version = await feedVersionGate("import");
    if (!version.allowed) throw new ImportError(`Import paused before any change. ${version.reason}`);
    await validateSelection(ids);
    const products = await remoteCatalog(api);
    for (const item of job.items) {
      if (stopping()) return;
      if (completed.includes(item.status)) continue;
      await db.importItem.update({ where: { jobId_supplierId: { jobId: id, supplierId: item.supplierId } },
        data: { status: "RUNNING", error: null, attempts: { increment: 1 } } });
      try {
        const mode = fulfillmentMode(item.fulfillmentMode);
        const input = payload(JSON.parse(item.payload), item.supplierId, id, job.locationId, mode);
        let claim = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
        const checkModeChange = async () => {
          const currentClaim = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
          if (currentClaim && fulfillmentMode(currentClaim.fulfillmentMode) !== mode) {
            const binding = await db.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
            if (binding?.enabled || binding?.status === "RUNNING" || binding?.pending) {
              throw new ImportError("Pause and reconcile inventory before changing fulfillment mode.");
            }
          }
        };
        await checkModeChange();
        const listing = review(item.listing, item.productId);
        const work = JSON.parse(item.listingWork) as ListingWork;
        if (listing.action === "BLOCKED") throw new ImportError(listing.message || "This listing requires a fresh recovery preview.");
        const saveWork = async (next: ListingWork) => {
          const updated = await db.importItem.updateMany({
            where: { jobId: id, supplierId: item.supplierId, status: "RUNNING" },
            data: { listingWork: JSON.stringify(next) },
          });
          if (updated.count !== 1) throw new ImportError("Listing work changed concurrently.");
        };
        const checkBinding = async () => {
          const binding = await db.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
          if (binding?.enabled || binding?.status === "RUNNING") throw new ImportError("Pause inventory synchronization before reconnecting or replacing this listing.");
          if (binding?.pending) throw new ImportError("Reconcile the uncertain paused inventory correction before reconnecting or replacing.");
          return binding;
        };
        const assertClaim = () => {
          if ((claim?.productId || null) !== (work.expectedProductId || null) ||
              (claim?.runId || null) !== (work.expectedClaimRun || null)) {
            throw new ImportError("Saved supplier mapping changed since preview. Re-preview before continuing.");
          }
        };
        if (listing.action === "LINK" || listing.action === "UPDATE") {
          assertClaim();
          if (listing.action === "LINK") await checkBinding();
          await checkModeChange();
          await checkTargetClaims(shop, item.supplierId, listing.targetId!);
          const existing = matchProduct(listing.action === "LINK" ? products.filter((product) => product.id !== listing.targetId) : products, item.supplierId);
          if (existing && existing.id !== listing.targetId) throw new ImportError("Supplier identity moved to a different listing. No mutation was applied.");
        }
        if (listing.action === "RECREATE" && !work.replacementReserved) {
          assertClaim();
          if (!work.expectedProductId || !claim?.productId) throw new ImportError("Replacement requires a certain saved creation mapping; uncertain claims cannot be reset.");
          if (Date.now() - job.createdAt.getTime() > MAX_PREVIEW_AGE) throw new ImportError("Replacement snapshot expired. Create a fresh preview.");
          await checkBinding();
          if (matchProduct(products, item.supplierId) || await listingSnapshot(api, work.expectedProductId)) {
            throw new ImportError("The old Shopify product still exists or its identity changed. Reconnect it; replacement is blocked.");
          }
          await db.$transaction(async (transaction) => {
            const binding = await transaction.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
            if (binding && (binding.enabled || binding.status === "RUNNING" || binding.pending)) {
              throw new ImportError("Pause and reconcile inventory before replacement.");
            }
            const reserved = await transaction.importClaim.updateMany({
              where: { shop, supplierId: item.supplierId, productId: work.expectedProductId!, runId: work.expectedClaimRun! },
              data: { runId: id, productId: null, mutationStartedAt: null, deletedAt: null, listingCheckedAt: null },
            });
            if (reserved.count !== 1) throw new ImportError("Replacement claim changed concurrently. No creation was authorized.");
            work.replacementReserved = true;
            await transaction.importItem.update({ where: { jobId_supplierId: { jobId: id, supplierId: item.supplierId } },
              data: { listingWork: JSON.stringify(work), productId: null } });
          });
          claim = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
        }
        if (listing.action === "RECREATE" && (claim?.runId !== id ||
            (claim.productId && matchProduct(products, item.supplierId)?.id !== claim.productId))) {
          throw new ImportError("Replacement reservation changed. Reconcile without resetting its creation guard.");
        }
        const result = listing.action === "LINK" || listing.action === "UPDATE"
          ? await applyListing({ api, input, policy, review: listing, work, supplierId: item.supplierId, runId: id, saveWork,
            beforeOperation: async () => {
              claim = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
              assertClaim();
              await checkTargetClaims(shop, item.supplierId, listing.targetId!);
              if (listing.action === "LINK") await checkBinding();
            },
          })
          : await importDraft({
          api, products, input, supplierId: item.supplierId, runId: id,
          ...settings,
          location: job.locationId,
          attempted: Boolean(claim?.mutationStartedAt),
          previouslyMapped: listing.action === "RECREATE" ? Boolean(claim?.productId) : Boolean(claim?.productId || item.productId),
          expectedProductId: claim?.productId || (listing.action === "RECREATE" ? null : item.productId),
          fresh: Date.now() - job.createdAt.getTime() <= MAX_PREVIEW_AGE,
          onCreated: async (productId) => {
            await db.$transaction([
              db.importClaim.upsert({
                where: { shop_supplierId: { shop, supplierId: item.supplierId } },
                create: { shop, supplierId: item.supplierId, runId: id, productId, fulfillmentMode: mode },
                update: { productId },
              }),
              db.importItem.update({ where: { jobId_supplierId: { jobId: id, supplierId: item.supplierId } }, data: { productId } }),
            ]);
          },
          beforeMutation: async () => {
            if (listing.action === "RECREATE") {
              await checkBinding();
              if (Date.now() - job.createdAt.getTime() > MAX_PREVIEW_AGE ||
                  await listingSnapshot(api, work.expectedProductId!) ||
                  matchProduct(await remoteCatalog(api), item.supplierId)) {
                throw new ImportError("Replacement approval expired or a live supplier product reappeared. Re-preview without resetting its creation guard.");
              }
            }
            await db.importClaim.upsert({
              where: { shop_supplierId: { shop, supplierId: item.supplierId } },
              create: { shop, supplierId: item.supplierId, runId: id, fulfillmentMode: mode }, update: {},
            });
            const reserved = await db.importClaim.updateMany({
              where: { shop, supplierId: item.supplierId, mutationStartedAt: null, productId: null,
                ...(listing.action === "RECREATE" ? { runId: id } : {}) },
              data: { runId: id, mutationStartedAt: new Date() },
            });
            if (reserved.count !== 1) throw new ImportError("Supplier product already has a creation claim. Reconcile before retrying.");
          },
        });
        let reconciledMappings: string | null = null;
        let bindingBaseline: { revision: number; productId: string; locationId: string } | null = null;
        if (listing.action === "LINK" || listing.action === "RECREATE") {
          const binding = await checkBinding();
          if (binding) {
            bindingBaseline = { revision: binding.revision, productId: binding.productId, locationId: binding.locationId };
            const snapshot = await listingSnapshot(api, result.productId);
            if (!snapshot) throw new ImportError("Replacement inventory target is unavailable. No inventory binding was enabled.");
            const variantIds = matchListingVariants(snapshot, input, false);
            const sourceIds = supplierVariantIds(input);
            reconciledMappings = JSON.stringify(variantIds.map((variantId, index) => ({
              sourceId: Number(sourceIds[index]), variantId,
              inventoryItemId: snapshot.variants.find((variant) => variant.id === variantId)!.inventoryItem.id,
            })).sort((a, b) => a.sourceId - b.sourceId));
          }
        }
        await db.$transaction(async (transaction) => {
          const currentClaim = await transaction.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
          if (currentClaim?.productId === result.productId && currentClaim.deletedAt) {
            throw new ImportError("The Shopify listing was deleted during import. Create a fresh recovery review.");
          }
          if (currentClaim && fulfillmentMode(currentClaim.fulfillmentMode) !== mode) {
            const binding = await transaction.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
            if (binding?.enabled || binding?.status === "RUNNING" || binding?.pending) throw new ImportError("Inventory enrollment changed during fulfillment review. Pause and reconcile it.");
          }
          if ((listing.action === "LINK" || listing.action === "RECREATE") && !bindingBaseline &&
              await transaction.inventorySync.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } })) {
            throw new ImportError("Inventory binding was added concurrently. Pause and reconcile it before continuing.");
          }
          if (reconciledMappings) {
            const updated = await transaction.inventorySync.updateMany({
              where: { shop, supplierId: item.supplierId, ...bindingBaseline!, enabled: false, status: { not: "RUNNING" }, pending: null },
              data: { productId: result.productId, mappings: reconciledMappings, enabled: false, status: "PAUSED",
                revision: { increment: 1 }, pending: null, pendingKey: null, pendingAt: null,
                generation: null, cursor: null, error: null, lastSuccessAt: null },
            });
            if (updated.count !== 1) throw new ImportError("Paused inventory binding changed concurrently. Reconcile before enabling.");
          }
          if (listing.action === "LINK" || listing.action === "UPDATE") {
            if (work.expectedClaimRun) {
              const updated = await transaction.importClaim.updateMany({
                where: { shop, supplierId: item.supplierId, runId: work.expectedClaimRun,
                  productId: work.expectedProductId || null },
                data: { productId: result.productId, fulfillmentMode: mode, deletedAt: null, listingCheckedAt: new Date() },
              });
              if (updated.count !== 1) throw new ImportError("Supplier mapping changed during listing work. Completed Shopify operations require reconciliation.");
            } else {
              await transaction.importClaim.create({ data: { shop, supplierId: item.supplierId, runId: id, productId: result.productId, fulfillmentMode: mode } });
            }
          } else await transaction.importClaim.upsert({
            where: { shop_supplierId: { shop, supplierId: item.supplierId } },
            create: { shop, supplierId: item.supplierId, runId: id, productId: result.productId, fulfillmentMode: mode },
            update: { productId: result.productId, fulfillmentMode: mode, deletedAt: null, listingCheckedAt: new Date() },
          });
          await transaction.importItem.update({ where: { jobId_supplierId: { jobId: id, supplierId: item.supplierId } }, data: { ...result, error: null } });
        });
      } catch (error) {
        console.error("Draft import item failed.", id, item.supplierId, error instanceof Error ? error.message : "Unknown failure");
        await db.importItem.update({ where: { jobId_supplierId: { jobId: id, supplierId: item.supplierId } },
          data: { status: "FAILED", error: error instanceof ImportError ? error.message : "Import interrupted or API access failed. Retry reconciliation; uncertain creations will not be repeated." } });
      }
    }
    const failed = await db.importItem.count({ where: { jobId: id, status: "FAILED" } });
    await db.importJob.update({ where: { id }, data: { status: failed ? "FAILED" : "COMPLETE", activeShop: null,
      error: failed ? `${failed} product(s) require review. Completed products will not be imported again.` : null } });
  } catch (error) {
    console.error("Draft import job failed.", id, error instanceof Error ? error.message : "Unknown failure");
    await db.importJob.update({ where: { id }, data: { status: "FAILED", activeShop: null,
      error: error instanceof Error ? error.message : "Unexpected import failure. Check worker logs." } });
  }
}
