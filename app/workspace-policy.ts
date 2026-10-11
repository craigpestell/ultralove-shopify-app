import { selectionIds, supplierText } from "./catalog-policy";
import { markupOverrides, markupPercent, pricingSignature } from "./pricing-policy";
import type { MarkupOverrides } from "./pricing-policy";
import { defaultListingPolicy, listingPolicy } from "./listing-policy";
import type { ListingPolicy } from "./listing-policy";

export type Configuration = { selected: number[]; markup: string; markups: MarkupOverrides };
export type ProductSummary = { id: number; name: string; sku: string; price: string | null; type: string };
export type Draft = Configuration & {
  baseline: string; products: Record<string, ProductSummary>; browse: string; active: boolean; publish: boolean;
  listingPolicy: ListingPolicy;
  selectionSearch: string; selectionPage: number;
};
export const SELECTION_PAGE_SIZE = 25;
export const signature = (value: Configuration) => pricingSignature(value.selected, value.markup, value.markups);

export function selectedPage(ids: number[], products: Record<string, Pick<ProductSummary, "name" | "sku">>, search: string, requestedPage: number) {
  const term = search.trim().replace(/\s+/g, " ").toLowerCase();
  const matches = ids.filter((id) => {
    const product = products[id];
    return !term || `${supplierText(product?.name ?? "")} ${supplierText(product?.sku ?? "")} ${id} #${id}`.replace(/\s+/g, " ").toLowerCase().includes(term);
  });
  const pages = Math.max(1, Math.ceil(matches.length / SELECTION_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, requestedPage));
  const offset = (page - 1) * SELECTION_PAGE_SIZE;
  return { ids: matches.slice(offset, offset + SELECTION_PAGE_SIZE), total: matches.length, page, pages,
    start: matches.length ? offset + 1 : 0, end: Math.min(offset + SELECTION_PAGE_SIZE, matches.length) };
}

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
    const existing = draft.listingPolicy ?? defaultListingPolicy();
    const policy = listingPolicy({ ...existing, mode: "KEEP" }, selected);
    if (existing.mode !== "KEEP" && existing.mode !== "UPDATE") return null;
    const selectionSearch = draft.selectionSearch ?? "";
    const selectionPage = draft.selectionPage ?? 1;
    if (typeof selectionSearch !== "string" || selectionSearch.length > 100 ||
        !Number.isSafeInteger(selectionPage) || selectionPage < 1) return null;
    return { selected, markup: draft.markup, markups: draft.markups, baseline: draft.baseline, products,
      listingPolicy: { ...policy, mode: existing.mode },
      selectionSearch, selectionPage,
      browse: browse.toString(), active: draft.active === true, publish: draft.active === true && draft.publish === true };
  } catch { return null; }
}

export function validPricing(value: Configuration): boolean {
  try { markupPercent(value.markup); markupOverrides(value.markups, value.selected); return true; }
  catch { return false; }
}

export function validListingChoices(value: Draft): boolean {
  try { listingPolicy(value.listingPolicy, value.selected); return true; }
  catch { return false; }
}

export function listingInput(value: unknown, ids: number[]): ListingPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return listingPolicy(value, ids);
  const input = value as Record<string, unknown>;
  if (!input.links || typeof input.links !== "object" || Array.isArray(input.links)) return listingPolicy(value, ids);
  const links = Object.fromEntries(Object.entries(input.links).map(([id, target]) => {
    if (typeof target !== "string") return [id, target];
    const trimmed = target.trim();
    const numeric = trimmed.match(/^[1-9]\d*$/)?.[0] ??
      trimmed.match(/^https:\/\/admin\.shopify\.com\/store\/[^/?#]+\/products\/([1-9]\d*)(?:[?#].*)?$/)?.[1];
    return [id, numeric ? `gid://shopify/Product/${numeric}` : trimmed];
  }));
  return listingPolicy({ ...input, links }, ids);
}

export function statusLabel(status: string): string {
  return ({
    PREVIEW: "Awaiting confirmation", QUEUED: "Queued", RUNNING: "In progress", COMPLETE: "Completed",
    FAILED: "Needs attention", CREATED: "Created", REUSED: "Existing listing kept", UPDATED: "Updated from UltraLove", LINKED: "Existing listing connected",
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
