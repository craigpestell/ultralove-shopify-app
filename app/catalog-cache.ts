// Supplier catalog pages are cached in the browser so switching tabs back to Catalog shows the
// last page right away instead of asking the supplier feed again. Wholesale-only products are
// already hidden in the cached response, and selection is draft state applied at render time,
// so neither changes what may be cached. Feed data (prices, stock) only changes at the supplier,
// so entries simply expire; the server keeps categories for the same 5 minutes.
export const CATALOG_CACHE_MS = 5 * 60 * 1000;
export const CATALOG_CACHE_LIMIT = 20;
const FILTER_KEYS = ["search", "category_id", "after_id"] as const;

/** Workspace views that browse the supplier feed. Review and Imports (or a job link without a view) do not. */
export function browsesFeed(params: URLSearchParams): boolean {
  const view = params.get("view");
  return view ? view === "catalog" : !params.has("job");
}

/** One key per feed page: search, category and cursor, ignoring embedded admin params and the view. */
export function catalogKey(params: URLSearchParams): string {
  const key = new URLSearchParams();
  for (const name of FILTER_KEYS) {
    const value = (params.get(name) || "").trim();
    if (value && value !== "0") key.set(name, value);
  }
  return key.toString();
}

/** A small time-limited cache; the oldest entries go first once it is full. */
export function catalogCache<T>(now: () => number = Date.now, ttl = CATALOG_CACHE_MS, limit = CATALOG_CACHE_LIMIT) {
  const entries = new Map<string, { at: number; value: T }>();
  return {
    get(key: string): T | null {
      const entry = entries.get(key);
      if (!entry) return null;
      if (now() - entry.at >= ttl) { entries.delete(key); return null; }
      return entry.value;
    },
    set(key: string, value: T) {
      entries.delete(key);
      entries.set(key, { at: now(), value });
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}
