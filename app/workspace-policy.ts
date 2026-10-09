import { selectionIds } from "./catalog-policy";
import { markupOverrides, markupPercent, pricingSignature } from "./pricing-policy";
import type { MarkupOverrides } from "./pricing-policy";

export type Configuration = { selected: number[]; markup: string; markups: MarkupOverrides };
export type ProductSummary = { id: number; name: string; sku: string; price: string | null; type: string };
export type Draft = Configuration & {
  baseline: string; products: Record<string, ProductSummary>; browse: string; active: boolean; publish: boolean;
};
export const signature = (value: Configuration) => pricingSignature(value.selected, value.markup, value.markups);

export function restoreDraft(value: unknown, saved: Configuration): Draft | null {
  try {
    if (!value || typeof value !== "object") return null;
    const draft = value as Draft;
    if (draft.baseline !== signature(saved)) return null;
    const selected = selectionIds(draft.selected);
    // Keep unfinished text edits without treating them as validated import configuration.
    if (typeof draft.markup !== "string" || draft.markup.length > 32 ||
        !draft.markups || typeof draft.markups !== "object" || Array.isArray(draft.markups) ||
        Object.entries(draft.markups).some(([id, markup]) => !selected.includes(Number(id)) || typeof markup !== "string" || markup.length > 32)) return null;
    if (!draft.products || typeof draft.products !== "object" || Array.isArray(draft.products)) return null;
    const products = Object.fromEntries(Object.entries(draft.products).filter(([id, product]) =>
      selected.includes(Number(id)) && product && product.id === Number(id) &&
      typeof product.name === "string" && typeof product.sku === "string" &&
      (product.price === null || typeof product.price === "string") && typeof product.type === "string"));
    const browse = new URLSearchParams(typeof draft.browse === "string" ? draft.browse : "");
    for (const key of [...browse.keys()]) if (!["search", "category_id", "after_id", "category_after"].includes(key)) browse.delete(key);
    return { selected, markup: draft.markup, markups: draft.markups, baseline: draft.baseline, products,
      browse: browse.toString(), active: draft.active === true, publish: draft.active === true && draft.publish === true };
  } catch { return null; }
}

export function validPricing(value: Configuration): boolean {
  try { markupPercent(value.markup); markupOverrides(value.markups, value.selected); return true; }
  catch { return false; }
}

export function statusLabel(status: string): string {
  return ({
    PREVIEW: "Awaiting confirmation", QUEUED: "Queued", RUNNING: "In progress", COMPLETE: "Completed",
    FAILED: "Needs attention", CREATED: "Created", REUSED: "Existing listing kept",
    NOT_ENROLLED: "Sync off", PAUSED: "Paused", ENABLED: "Sync on", IDLE: "Sync on", SYNCED: "Up to date", REVIEW: "Review required",
  } as Record<string, string>)[status] ?? status.toLowerCase().replaceAll("_", " ");
}

export function workspaceHref(search: string, view: string, browse = "", job?: string): string {
  const params = new URLSearchParams(search);
  for (const key of ["index", "view", "job", "search", "category_id", "after_id", "category_after"]) params.delete(key);
  if (view === "catalog" || view === "selection") {
    for (const [key, value] of new URLSearchParams(browse)) {
      if (["search", "category_id", "after_id", "category_after"].includes(key)) params.set(key, value);
    }
  }
  params.set("view", view);
  if (job) params.set("job", job);
  return `${view === "inventory" ? "/app/inventory" : "/app"}?${params}`;
}
