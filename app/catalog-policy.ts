export function selectionIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 50 ||
      value.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      new Set(value).size !== value.length) {
    throw new Error("Select at most 50 distinct positive supplier product IDs.");
  }
  return value.slice().sort((a, b) => a - b);
}

export function browseFilters(url: URL) {
  const readId = (key: string): number => {
    const values = url.searchParams.getAll(key);
    if (values.length > 1 || (values.length && !/^\d+$/.test(values[0]))) {
      throw new Error(`Invalid ${key} filter.`);
    }
    const value = Number(values[0] || 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${key} filter.`);
    return value;
  };
  const searches = url.searchParams.getAll("search");
  const search = (searches[0] || "").trim();
  if (searches.length > 1 || [...search].length > 100) throw new Error("Search is limited to 100 characters.");
  const category = readId("category_id");
  return {
    after_id: readId("after_id"),
    ...(category ? { category_id: category } : {}),
    ...(search ? { search } : {}),
    categoryAfter: readId("category_after"),
  };
}
import { decodeHTML } from "entities";

export function supplierText(value: string): string {
  return decodeHTML(value.replace(/<[^>]*>/g, " "));
}
