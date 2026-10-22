import prisma from "./db.server";
import { categoriesPage, CatalogError } from "./catalog.server";
import { blocking, FEED_VERSION_RESULTS, FEED_VERSION_TRIGGERS, feedVersionVerdict } from "./feed-version";
import type { FeedVersionResult, FeedVersionTrigger, FeedVersionVerdict } from "./feed-version";

const ID = "lab";
// Inventory sync reuses a recent check instead of asking the feed before every cycle.
export const INVENTORY_CHECK_AGE = 60 * 1000;
// While the feed is unsupported, inventory sync looks again this often and resumes by itself.
export const BLOCKED_RECHECK_AGE = 5 * 60 * 1000;

export type FeedVersionCheck = FeedVersionVerdict & { checkedAt: string; trigger: FeedVersionTrigger };

/** The latest recorded check, or null before the first one. */
export async function lastFeedVersionCheck(): Promise<FeedVersionCheck | null> {
  const row = await prisma.feedVersionCheck.findUnique({ where: { id: ID } });
  if (!row || !FEED_VERSION_RESULTS.includes(row.result as FeedVersionResult) ||
      !FEED_VERSION_TRIGGERS.includes(row.trigger as FeedVersionTrigger)) return null;
  const result = row.result as FeedVersionResult;
  return { checkedAt: row.checkedAt.toISOString(), trigger: row.trigger as FeedVersionTrigger,
    version: row.version, result, allowed: !blocking(result), reason: row.reason };
}

/** Reads the feed's schema version from one category page and records the outcome. */
export async function checkFeedVersion(trigger: FeedVersionTrigger,
  read: () => Promise<{ schemaVersion?: unknown }> = () => categoriesPage(0)): Promise<FeedVersionCheck> {
  let verdict: FeedVersionVerdict;
  try {
    verdict = feedVersionVerdict((await read()).schemaVersion);
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    // The import or sync that follows reads the same feed and reports the connection problem itself.
    verdict = { version: null, result: "unavailable", allowed: true, reason: error.message };
  }
  if (!verdict.allowed) console.warn("Supplier feed schema is not supported.", trigger, verdict.result, verdict.version);
  const row = { checkedAt: new Date(), trigger, version: verdict.version, result: verdict.result, reason: verdict.reason };
  await prisma.feedVersionCheck.upsert({ where: { id: ID }, create: { id: ID, ...row }, update: row });
  return { ...verdict, checkedAt: row.checkedAt.toISOString(), trigger };
}

/**
 * Checks the feed before work that reads it. Imports always check; inventory sync reuses a check
 * younger than INVENTORY_CHECK_AGE, or BLOCKED_RECHECK_AGE while the feed is unsupported.
 */
export async function feedVersionGate(trigger: FeedVersionTrigger,
  read?: () => Promise<{ schemaVersion?: unknown }>): Promise<FeedVersionCheck> {
  if (trigger === "inventory") {
    const last = await lastFeedVersionCheck();
    const age = last ? Date.now() - Date.parse(last.checkedAt) : Infinity;
    if (last && age < (last.allowed ? INVENTORY_CHECK_AGE : BLOCKED_RECHECK_AGE)) return last;
  }
  return checkFeedVersion(trigger, read);
}
