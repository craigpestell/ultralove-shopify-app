import { allCategories, productsPage } from "./catalog.server";

/** One catalog page plus every category, as the Catalog tab shows them. */
export async function browseCatalog(filters: { search?: string; category_id?: number; after_id: number }) {
  // Categories load in full and sorted, so the legacy category_after cursor is ignored.
  const productFilters = { search: filters.search, category_id: filters.category_id, after_id: filters.after_id };
  const [products, categories] = await Promise.all([productsPage(productFilters), allCategories()]);
  return { products, categories };
}

export type CatalogBrowse = Awaited<ReturnType<typeof browseCatalog>>;
