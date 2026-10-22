// Summary of the latest catalog import and inventory sync, published as a shop
// metafield so the storefront's import status page can render it in Liquid.
export const STATUS_NAMESPACE = "ultralove";
export const STATUS_KEY = "import_status";
export const STATUS_INTERVAL = 60_000;
const ISSUE_LIMIT = 25;
const HISTORY_LIMIT = 5;

export type StatusItem = { supplierId: number; name: string; sku: string; status: string; error: string | null; variants: number };
export type StatusJob = { id: string; status: string; error: string | null; createdAt: Date; updatedAt: Date; items: StatusItem[] };
export type StatusSync = { supplierId: number; enabled: boolean; status: string; error: string | null; lastSuccessAt: Date | null; nextRunAt: Date };
export type StatusClaim = { supplierId: number; deletedAt: Date | null };

const outcomes = { CREATED: "created", REUSED: "created", UPDATED: "updated", LINKED: "updated", FAILED: "failed" } as const;
type Outcome = (typeof outcomes)[keyof typeof outcomes] | "pending";
function outcome(status: string): Outcome {
  return outcomes[status as keyof typeof outcomes] || "pending";
}

function counts(items: StatusItem[]) {
  const products = { total: items.length, created: 0, updated: 0, failed: 0, pending: 0 };
  const variants = { total: 0, created: 0, updated: 0, failed: 0, pending: 0 };
  for (const item of items) {
    const key = outcome(item.status);
    products[key]++;
    variants[key] += item.variants;
    variants.total += item.variants;
  }
  return { products, variants };
}

export function importStatus(input: { jobs: StatusJob[]; syncs: StatusSync[]; claims: StatusClaim[]; names: Map<number, string>; now: Date }) {
  const [latest] = input.jobs;
  const current = new Set(input.claims.filter((claim) => !claim.deletedAt).map((claim) => claim.supplierId));
  const syncs = input.syncs.filter((sync) => current.has(sync.supplierId));
  const enrolled = syncs.filter((sync) => sync.enabled);
  const states: Record<string, number> = {};
  for (const sync of enrolled) states[sync.status] = (states[sync.status] || 0) + 1;
  const last = enrolled.map((sync) => sync.lastSuccessAt?.getTime() || 0).reduce((a, b) => Math.max(a, b), 0);
  const next = enrolled.map((sync) => sync.nextRunAt.getTime()).reduce((a, b) => Math.min(a, b), Infinity);
  const failures = syncs.filter((sync) => sync.status === "FAILED" || sync.status === "REVIEW");
  return {
    generatedAt: input.now.toISOString(),
    latest: latest ? {
      id: latest.id, status: latest.status, error: latest.error,
      startedAt: latest.createdAt.toISOString(),
      finishedAt: ["COMPLETE", "FAILED"].includes(latest.status) ? latest.updatedAt.toISOString() : null,
      ...counts(latest.items),
      issues: latest.items.filter((item) => item.status === "FAILED").slice(0, ISSUE_LIMIT)
        .map((item) => ({ supplierId: item.supplierId, name: item.name, sku: item.sku, error: item.error || "Import failed." })),
      issueCount: latest.items.filter((item) => item.status === "FAILED").length,
    } : null,
    history: input.jobs.slice(0, HISTORY_LIMIT).map((job) => {
      const { products } = counts(job.items);
      return { id: job.id, status: job.status, startedAt: job.createdAt.toISOString(), ...products };
    }),
    inventory: {
      listed: current.size,
      enrolled: enrolled.length,
      paused: syncs.length - enrolled.length,
      notEnrolled: current.size - syncs.length,
      states,
      lastSuccessAt: last ? new Date(last).toISOString() : null,
      nextRunAt: Number.isFinite(next) ? new Date(next).toISOString() : null,
      issues: failures.slice(0, ISSUE_LIMIT).map((sync) => ({ supplierId: sync.supplierId,
        name: input.names.get(sync.supplierId) || `Product #${sync.supplierId}`, error: sync.error || "Inventory sync failed." })),
      issueCount: failures.length,
    },
  };
}

export type ImportStatus = ReturnType<typeof importStatus>;
