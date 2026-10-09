import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import db from "./db.server";
import { selectionIds } from "./catalog-policy";
import { importPlan, validateSelection } from "./catalog.server";
import { assertLabShop } from "./lab-policy.server";
import { ImportError, MAX_PREVIEW_AGE, importDraft, markupPercent, matchProduct, payload, plannedFeed, priceRange, remoteCatalog, reviewLabels, shopContext } from "./import-engine";
import type { GraphQL } from "./import-engine";

export async function savedSelection(shop: string) {
  assertLabShop(shop);
  const saved = await db.catalogSelection.findUnique({ where: { shop } });
  return selectionIds(saved ? JSON.parse(saved.productIds) : []);
}

export async function createPreview(shop: string, markup: string, api: GraphQL) {
  assertLabShop(shop);
  const ids = await savedSelection(shop);
  if (!ids.length) throw new ImportError("Save between 1 and 50 selected parent products before reviewing pricing.");
  const normalized = markupPercent(markup);
  const location = await shopContext(api, shop);
  const run = randomBytes(16).toString("hex");
  const plan = plannedFeed(await importPlan(ids, location, run, normalized), ids, run, location);
  const products = await remoteCatalog(api);
  for (const item of plan.items) matchProduct(products, item.supplierId);
  return db.importJob.create({
    data: {
      id: run, shop, selection: JSON.stringify(ids), markup: normalized, locationId: location,
      generation: plan.generation, cursor: plan.cursor,
      items: { create: plan.items.map((item) => ({
        supplierId: item.supplierId, name: item.name, sku: item.sku,
        wholesale: JSON.stringify(item.wholesale), payload: JSON.stringify(item.payload),
        productId: matchProduct(products, item.supplierId)?.id || null,
      })) },
    },
  });
}

export async function queueJob(shop: string, id: string, retry: boolean) {
  assertLabShop(shop);
  const job = await db.importJob.findFirst({ where: { id, shop } });
  if (!job || job.status !== (retry ? "FAILED" : "PREVIEW")) throw new ImportError("This job cannot be queued in its current state.");
  if (!retry && Date.now() - job.createdAt.getTime() > MAX_PREVIEW_AGE) throw new ImportError("Pricing preview expired. Create a fresh preview.");
  if (!retry && JSON.stringify(await savedSelection(shop)) !== job.selection) throw new ImportError("Saved selections changed. Create a fresh pricing preview.");
  try {
    const updated = await db.importJob.updateMany({
      where: { id, shop, status: job.status },
      data: { status: "QUEUED", activeShop: shop, error: null },
    });
    if (updated.count !== 1) throw new ImportError("Another request changed this job. Refresh its status.");
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    throw new ImportError("Another import job is queued or running for this store. Wait for its result.");
  }
}

export async function importScreen(shop: string, id: string | null) {
  assertLabShop(shop);
  const [selected, history, current] = await Promise.all([
    savedSelection(shop),
    db.importJob.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 10,
      select: { id: true, status: true, markup: true, createdAt: true, items: { select: { status: true } } } }),
    id ? db.importJob.findFirst({ where: { id, shop }, include: { items: { orderBy: { supplierId: "asc" } } } }) : null,
  ]);
  if (id && !current) throw new Response("Import job not found.", { status: 404 });
  const job = current && {
    id: current.id, status: current.status, markup: current.markup, createdAt: current.createdAt.toISOString(),
    error: current.error, generation: current.generation, cursor: current.cursor,
    items: current.items.map((item) => {
      const input = payload(JSON.parse(item.payload), item.supplierId, current.id, current.locationId);
      return {
        supplierId: item.supplierId, name: item.name, sku: item.sku, status: item.status,
        productId: item.productId, error: item.error, attempts: item.attempts,
        wholesale: priceRange(JSON.parse(item.wholesale)), retail: priceRange(input.variants.map((variant) => variant.price)),
        variantCount: input.variants.length, warnings: reviewLabels(input),
      };
    }),
  };
  return { selected, job, history: history.map((entry) => ({
    id: entry.id, status: entry.status, markup: entry.markup, createdAt: entry.createdAt.toISOString(),
    completed: entry.items.filter((item) => item.status === "CREATED" || item.status === "REUSED").length,
    total: entry.items.length,
  })) };
}

export async function runJob(id: string, shop: string, api: GraphQL, stopping: () => boolean) {
  assertLabShop(shop);
  const claimed = await db.importJob.updateMany({ where: { id, shop, status: "QUEUED" }, data: { status: "RUNNING" } });
  if (claimed.count !== 1) return;
  const job = await db.importJob.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { supplierId: "asc" } } } });
  try {
    const ids = selectionIds(JSON.parse(job.selection));
    if (!ids.length || ids.length !== job.items.length) throw new ImportError("Invalid immutable job selection.");
    if (await shopContext(api, shop) !== job.locationId) throw new ImportError("Approved inventory location changed. No new drafts were created.");
    await validateSelection(ids);
    const products = await remoteCatalog(api);
    for (const item of job.items) {
      if (stopping()) return;
      if (item.status === "CREATED" || item.status === "REUSED") continue;
      await db.importItem.update({ where: { jobId_supplierId: { jobId: id, supplierId: item.supplierId } },
        data: { status: "RUNNING", error: null, attempts: { increment: 1 } } });
      try {
        const input = payload(JSON.parse(item.payload), item.supplierId, id, job.locationId);
        const claim = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: item.supplierId } } });
        const result = await importDraft({
          api, products, input, supplierId: item.supplierId, runId: id,
          attempted: Boolean(claim?.mutationStartedAt), previouslyMapped: Boolean(claim?.productId || item.productId),
          expectedProductId: claim?.productId || item.productId,
          fresh: Date.now() - job.createdAt.getTime() <= MAX_PREVIEW_AGE,
          beforeMutation: async () => {
            await db.importClaim.upsert({
              where: { shop_supplierId: { shop, supplierId: item.supplierId } },
              create: { shop, supplierId: item.supplierId, runId: id }, update: {},
            });
            const reserved = await db.importClaim.updateMany({
              where: { shop, supplierId: item.supplierId, mutationStartedAt: null, productId: null },
              data: { runId: id, mutationStartedAt: new Date() },
            });
            if (reserved.count !== 1) throw new ImportError("Supplier product already has a creation claim. Reconcile before retrying.");
          },
        });
        await db.$transaction([
          db.importClaim.upsert({
            where: { shop_supplierId: { shop, supplierId: item.supplierId } },
            create: { shop, supplierId: item.supplierId, runId: id, productId: result.productId },
            update: { productId: result.productId },
          }),
          db.importItem.update({ where: { jobId_supplierId: { jobId: id, supplierId: item.supplierId } }, data: { ...result, error: null } }),
        ]);
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
