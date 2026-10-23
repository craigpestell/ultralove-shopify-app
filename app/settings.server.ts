import { randomUUID } from "node:crypto";
import { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import prisma from "./db.server";
import { assertShopDomain } from "./shop-policy.server";
import { categoriesPage, CatalogError } from "./catalog.server";

const ID = "lab";
// Written by provisioning and ops/lab-pull-deploy.sh on the lab host; absent in development.
const CURRENT_RELEASE = "/srv/ultralove-shopify/current";
const UPDATE_STATUS = "/var/lib/ultralove-shopify-deploy/status.json";
// Watched by ultralove-shopify-deploy.path, which starts a check when a new request ID is written.
const UPDATE_REQUEST = "/var/lib/ultralove-shopify/update-check-request";
const UPDATE_RESULTS = ["off", "current", "waiting", "deploying", "deployed", "failed", "error"] as const;
const REQUEST_ID = /^[a-f0-9-]{36}$/;

export type UpdateStatus = {
  checkedAt: string; result: (typeof UPDATE_RESULTS)[number]; release: string | null; checks: string | null; request: string | null;
};

/** Automatic updates stay on until the operator turns them off, including before the row exists. */
export async function appSettings(shop: string) {
  const [row, pausedShops] = await Promise.all([prisma.appSettings.findUnique({ where: { id: ID } }), pausedInventoryShops()]);
  return { autoUpdates: row?.autoUpdates ?? true, inventoryPaused: pausedShops.includes(shop) };
}

/** Automatic updates apply to the whole app host; only the operator store may change them. */
export async function updateAutoUpdates(autoUpdates: boolean) {
  await prisma.appSettings.upsert({ where: { id: ID }, create: { id: ID, autoUpdates }, update: { autoUpdates } });
}

/** Pauses or resumes inventory sync for every product of one store. */
export async function updateInventoryPaused(shop: string, inventoryPaused: boolean) {
  assertShopDomain(shop);
  await prisma.shopSettings.upsert({ where: { shop }, create: { shop, inventoryPaused }, update: { inventoryPaused } });
}

/** True while this store paused inventory sync for every product from Settings. */
export async function inventoryPaused(shop: string) {
  return (await prisma.shopSettings.findUnique({ where: { shop }, select: { inventoryPaused: true } }))?.inventoryPaused ?? false;
}

/** Stores whose inventory sync is paused, so the worker skips them. */
export async function pausedInventoryShops() {
  return (await prisma.shopSettings.findMany({ where: { inventoryPaused: true }, select: { shop: true } })).map((row) => row.shop);
}

type InventoryRow = { deletedAt: string | null; enabled: boolean; status: string; error: string | null; lastSuccessAt: string | null; nextRunAt: string | null };

/** Totals for the Settings page from the Inventory page's rows, ignoring deleted listings. */
export function inventoryHealth(products: InventoryRow[]) {
  const enabled = products.filter((product) => !product.deletedAt && product.enabled);
  const latest = (values: (string | null)[], pick: (a: string, b: string) => string) =>
    values.reduce<string | null>((found, value) => !value ? found : !found ? value : pick(found, value), null);
  return {
    enabled: enabled.length,
    review: products.filter((product) => !product.deletedAt && (product.error || ["FAILED", "REVIEW"].includes(product.status))).length,
    lastSuccessAt: latest(enabled.map((product) => product.lastSuccessAt), (a, b) => a > b ? a : b),
    nextRunAt: latest(enabled.map((product) => product.nextRunAt), (a, b) => a < b ? a : b),
  };
}

/** The live release and when provisioning switched to it, or null outside the lab host. */
export async function currentRelease(path = CURRENT_RELEASE) {
  try {
    const release = basename(await readlink(path));
    if (!/^[a-f0-9]{40}$/.test(release)) return null;
    return { release, deployedAt: (await lstat(path)).mtime.toISOString() };
  } catch {
    return null;
  }
}

/** The outcome of the latest update check, or null when none has been recorded or it is unreadable. */
export async function updateStatus(path = UPDATE_STATUS): Promise<UpdateStatus | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const { checkedAt, result, release, checks, request } = value as Record<string, unknown>;
    if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt)) ||
        !UPDATE_RESULTS.includes(result as UpdateStatus["result"])) return null;
    return {
      checkedAt: new Date(checkedAt).toISOString(), result: result as UpdateStatus["result"],
      release: typeof release === "string" && /^[a-f0-9]{40}$/.test(release) ? release : null,
      checks: typeof checks === "string" && /^[a-z_]{1,40}$/.test(checks) ? checks : null,
      request: typeof request === "string" && REQUEST_ID.test(request) ? request : null,
    };
  } catch {
    return null;
  }
}

/**
 * Asks the lab to check for a new release now. Returns the request ID that the check's
 * recorded status will carry, or null where there is no lab deploy service to ask.
 */
export async function requestUpdateCheck(path = UPDATE_REQUEST) {
  const request = randomUUID();
  try {
    await writeFile(path, `${request}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
  return request;
}

/** Reads one page of supplier categories to prove the catalog feed answers. */
export async function catalogConnection(read: () => Promise<unknown> = () => categoriesPage(0)) {
  const started = Date.now();
  try {
    await read();
    return { connected: true as const, error: null, milliseconds: Date.now() - started };
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    return { connected: false as const, error: error.message, milliseconds: Date.now() - started };
  }
}
