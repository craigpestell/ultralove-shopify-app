import { lstat, readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";
import prisma from "./db.server";
import { categoriesPage, CatalogError } from "./catalog.server";

const ID = "lab";
// Written by provisioning and ops/lab-pull-deploy.sh on the lab host; absent in development.
const CURRENT_RELEASE = "/srv/ultralove-shopify/current";
const UPDATE_STATUS = "/var/lib/ultralove-shopify-deploy/status.json";
const UPDATE_RESULTS = ["off", "current", "waiting", "deployed", "failed", "error"] as const;

export type UpdateStatus = { checkedAt: string; result: (typeof UPDATE_RESULTS)[number]; release: string | null; checks: string | null };

/** Automatic updates stay on until someone turns them off, including before the row exists. */
export async function appSettings() {
  const row = await prisma.appSettings.findUnique({ where: { id: ID } });
  return { autoUpdates: row?.autoUpdates ?? true, updatedAt: row?.updatedAt.toISOString() ?? null };
}

export async function setAutoUpdates(autoUpdates: boolean) {
  await prisma.appSettings.upsert({ where: { id: ID }, create: { id: ID, autoUpdates }, update: { autoUpdates } });
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
    const { checkedAt, result, release, checks } = value as Record<string, unknown>;
    if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt)) ||
        !UPDATE_RESULTS.includes(result as UpdateStatus["result"])) return null;
    return {
      checkedAt: new Date(checkedAt).toISOString(), result: result as UpdateStatus["result"],
      release: typeof release === "string" && /^[a-f0-9]{40}$/.test(release) ? release : null,
      checks: typeof checks === "string" && /^[a-z_]{1,40}$/.test(checks) ? checks : null,
    };
  } catch {
    return null;
  }
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
