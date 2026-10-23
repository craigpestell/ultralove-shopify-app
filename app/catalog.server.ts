import { execFile } from "node:child_process";
import { CATALOG_BATCH_SIZE, selectionIds, supplierText } from "./catalog-policy.ts";
import type { ProductSummary } from "./workspace-policy";

export class CatalogError extends Error {
  readonly retryAfter: number | null;
  constructor(message: string, retryAfter: number | null = null) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

type Transport = (request: object) => Promise<unknown>;
const WHOLESALE_ONLY_MESSAGE = "A selected product is wholesale-only at UltraLove (a tester, display or other store-only item) and can't be dropshipped. Remove it from your selection; nothing was imported.";

/** Feed 1.3 marks testers, displays and other store-only products; older feeds omit the field. */
function wholesaleOnly(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  throw new CatalogError("Supplier catalog returned an invalid wholesale-only flag.");
}
export type CatalogProduct = {
  id: number; parent_id: number; name: string; sku: string; type: string;
  price: string | null; currency: string; manage_stock: boolean;
  stock_quantity: number | null; stock_owner_id: number | null;
  images: { src: string; alt: string }[];
};
type Category = { id: number; name: string };
type Page<T> = { next_after_id: number; has_more: boolean } & T;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelope(value: unknown) {
  if (!object(value) || !Number.isSafeInteger(value.next_after_id) ||
      Number(value.next_after_id) < 0 || typeof value.has_more !== "boolean") {
    throw new CatalogError("Supplier catalog returned invalid pagination.");
  }
  return value;
}

const sshTransport: Transport = (request) => new Promise((resolve, reject) => {
  const host = process.env.CATALOG_SSH_HOST;
  if (!host || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    console.error("The approved supplier SSH host is not configured.");
    reject(new CatalogError("Supplier connection is not configured."));
    return;
  }
  const child = execFile("/usr/bin/ssh", [
    "-i", "/etc/ultralove-shopify/catalog/catalog_ed25519",
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "UserKnownHostsFile=/etc/ultralove-shopify/catalog/known_hosts",
    "-o", "ConnectTimeout=10",
    `ultralove-catalog-proxy@${host}`, "catalog-read",
  ], { timeout: 150000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error) {
      console.error("Restricted supplier catalog transport failed.", error.code);
      if (stdout.trim()) {
        try {
          const response: unknown = JSON.parse(stdout);
          if (object(response) && object(response.error) && response.error.status === 409 &&
              response.error.code === "WHOLESALE_ONLY") {
            reject(new CatalogError(WHOLESALE_ONLY_MESSAGE));
            return;
          }
          if (object(response) && object(response.error) && response.error.status === 409 &&
              response.error.code === "SELECTED_PRODUCT_UNAVAILABLE") {
            reject(new CatalogError("A selected supplier product or variant is no longer published or available. Review your selection before retrying; no partial supplier data was accepted."));
            return;
          }
          if (object(response) && object(response.error) && response.error.status === 429 &&
              typeof response.error.retryAfter === "number" && Number.isSafeInteger(response.error.retryAfter) &&
              response.error.retryAfter > 0 && response.error.retryAfter <= 2147483647) {
            reject(new CatalogError(`Supplier rate limit: retry after ${response.error.retryAfter} seconds.`, response.error.retryAfter));
            return;
          }
        } catch (parseError) {
          if (!(parseError instanceof SyntaxError)) throw parseError;
          console.warn("Supplier failure response was not valid JSON.");
        }
      }
      reject(new CatalogError("Supplier connection is unavailable. Retry shortly; no new supplier data was accepted."));
      return;
    }
    try {
      resolve(JSON.parse(stdout));
    } catch (parseError) {
      if (!(parseError instanceof SyntaxError)) throw parseError;
      console.error("Supplier catalog returned invalid JSON.");
      reject(new CatalogError("Supplier catalog returned an invalid response."));
    }
  });
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    console.error("Supplier catalog request could not be sent.", error.code);
    reject(new CatalogError("Supplier catalog request could not be sent."));
  });
  child.stdin?.end(JSON.stringify(request));
});

/** One catalog page without wholesale-only products; `hidden` counts the ones left out, so a page can show fewer than 50. */
export async function productsPage(filters: object, transport: Transport = sshTransport): Promise<Page<{ products: CatalogProduct[]; hidden: number }>> {
  const data = envelope(await transport({ operation: "products", filters }));
  if (!Array.isArray(data.products) || data.products.length > 50) throw new CatalogError("Supplier catalog exceeded its 50-product page limit.");
  const records: unknown[] = data.products;
  const listed = records.filter((record) => !(object(record) && wholesaleOnly(record.wholesale_only)));
  const products: CatalogProduct[] = listed.map((record: unknown) => {
    if (!object(record) || !Number.isSafeInteger(record.id) || Number(record.id) < 1 ||
        record.parent_id !== 0 || typeof record.name !== "string" || typeof record.sku !== "string" ||
        typeof record.type !== "string" || !(record.price === null || typeof record.price === "string") ||
        record.currency !== "CAD" || typeof record.manage_stock !== "boolean" ||
        !(record.stock_quantity === null || typeof record.stock_quantity === "number") ||
        !(record.stock_owner_id === null || Number.isSafeInteger(record.stock_owner_id)) ||
        !Array.isArray(record.images)) throw new CatalogError("Supplier catalog returned an invalid product.");
    const images = record.images.map((image: unknown) => {
      if (!object(image) || typeof image.src !== "string" || typeof image.alt !== "string") {
        throw new CatalogError("Supplier catalog returned invalid media.");
      }
      return {
        src: image.src.replace(/^https:\/\/dev\.ultralove\.ca\/wp-content\/uploads\//, "https://ultralove.ca/wp-content/uploads/"),
        alt: image.alt,
      };
    });
    return {
      id: Number(record.id), parent_id: 0, name: record.name, sku: record.sku, type: record.type,
      price: record.price, currency: record.currency, manage_stock: record.manage_stock,
      stock_quantity: record.stock_quantity, stock_owner_id: record.stock_owner_id === null ? null : Number(record.stock_owner_id),
      images,
    };
  });
  return { products, hidden: records.length - listed.length, next_after_id: Number(data.next_after_id), has_more: Boolean(data.has_more) };
}

export async function categoriesPage(after: number, transport: Transport = sshTransport): Promise<Page<{ categories: Category[]; schemaVersion: unknown }>> {
  const data = envelope(await transport({ operation: "categories", filters: { after_id: after } }));
  if (!Array.isArray(data.categories) || data.categories.length > 50) throw new CatalogError("Supplier category page exceeded its limit.");
  const categories = data.categories.map((record: unknown) => {
    if (!object(record) || !Number.isSafeInteger(record.id) || Number(record.id) < 1 || typeof record.name !== "string") {
      throw new CatalogError("Supplier catalog returned an invalid category.");
    }
    return { id: Number(record.id), name: record.name };
  });
  // Checked by feed-version.server.ts; feeds from before versioning leave it undefined.
  return { categories, next_after_id: Number(data.next_after_id), has_more: Boolean(data.has_more), schemaVersion: data.schema_version };
}

const CATEGORY_PAGE_LIMIT = 40;
const CATEGORY_CACHE_MS = 5 * 60 * 1000;
let categoryCache: { at: number; categories: Category[] } | null = null;

/** Every supplier category, sorted by name. The feed pages by ID, so read every page before sorting. */
export async function allCategories(transport: Transport = sshTransport): Promise<{ categories: Category[] }> {
  const cached = transport === sshTransport && categoryCache && Date.now() - categoryCache.at < CATEGORY_CACHE_MS;
  if (cached) return { categories: categoryCache!.categories };
  const categories: Category[] = [];
  let after = 0;
  for (let page = 0; ; page++) {
    if (page === CATEGORY_PAGE_LIMIT) throw new CatalogError("Supplier category list exceeded its limit.");
    const result = await categoriesPage(after, transport);
    categories.push(...result.categories);
    if (!result.has_more) break;
    if (result.next_after_id <= after) throw new CatalogError("Supplier catalog returned invalid pagination.");
    after = result.next_after_id;
  }
  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  categories.sort((a, b) => collator.compare(supplierText(a.name).trim(), supplierText(b.name).trim()) || a.id - b.id);
  if (transport === sshTransport) categoryCache = { at: Date.now(), categories };
  return { categories };
}

export async function validateSelection(ids: number[], transport: Transport = sshTransport): Promise<void> {
  const selectedIds = selectionIds(ids);
  for (let offset = 0; offset < selectedIds.length; offset += CATALOG_BATCH_SIZE) {
    const batch = selectedIds.slice(offset, offset + CATALOG_BATCH_SIZE);
    const data = await transport({ operation: "selection", ids: batch });
    const selected = object(data) ? data.ids : null;
    if (!Array.isArray(selected) || selected.length !== batch.length ||
        !batch.every((id) => selected.includes(id))) {
      throw new CatalogError("Some selected products are no longer published. Refresh the catalog and revise the selection.");
    }
    // A proxy from before feed 1.3 sends no flags; the import plan still refuses flagged products.
    const flagged = object(data) && Array.isArray(data.products)
      ? data.products.filter((product: unknown) => object(product) && wholesaleOnly(product.wholesale_only)) : [];
    if (flagged.length) {
      // Feed names already start with the SKU.
      const names = flagged.map((product: Record<string, unknown>) =>
        typeof product.name === "string" ? supplierText(product.name).trim() : `#${String(product.id)}`);
      throw new CatalogError(`These selected products are wholesale-only at UltraLove (testers, displays or other store-only items) and can't be dropshipped: ${names.join("; ")}. Remove them from your selection.`);
    }
  }
}

export async function selectedProducts(ids: number[], transport: Transport = sshTransport): Promise<ProductSummary[]> {
  const selected = selectionIds(ids);
  if (!selected.length || selected.length > CATALOG_BATCH_SIZE) throw new CatalogError("Request 1-50 selected product details at a time.");
  const data = await transport({ operation: "selection", ids: selected });
  if (!object(data) || !Array.isArray(data.ids) || data.ids.length !== selected.length ||
      !Array.isArray(data.products) ||
      data.products.length !== selected.length) {
    throw new CatalogError("Selected product details are incomplete. Refresh the selection or check the supplier connection.");
  }
  const confirmed = data.ids;
  if (!selected.every((id) => confirmed.includes(id))) throw new CatalogError("Some selected products are no longer published by UltraLove.");
  const seen = new Set<number>();
  return data.products.map((product: unknown) => {
    if (!object(product) || typeof product.id !== "number" || !selected.includes(product.id) || seen.has(product.id) ||
        typeof product.name !== "string" || typeof product.sku !== "string" || typeof product.type !== "string" ||
        !(product.price === null || typeof product.price === "string")) {
      throw new CatalogError("Selected product details contain an invalid product.");
    }
    seen.add(product.id);
    const summary: ProductSummary = { id: product.id, name: product.name, sku: product.sku, price: product.price, type: product.type };
    return wholesaleOnly(product.wholesale_only) ? { ...summary, wholesaleOnly: true } : summary;
  });
}

export async function importPlan(ids: number[], location: string, run: string, markup: string, transport: Transport = sshTransport): Promise<unknown> {
  return transport({ operation: "import-plan", ids, location, run, markup });
}

export async function inventoryState(id: number, checkpoint: { generation: string; cursor: number } | null, transport: Transport = sshTransport): Promise<unknown> {
  return transport({ operation: "inventory-sync", ids: [id], checkpoint });
}

export async function inventoryStates(products: { supplierId: number; checkpoint: { generation: string; cursor: number } | null }[],
  transport: Transport = sshTransport): Promise<unknown[]> {
  const ids = products.map((product) => product.supplierId);
  if (!ids.length || ids.length > 50 || ids.some((id) => !Number.isInteger(id) || id < 1 || id > 2147483647) ||
      new Set(ids).size !== ids.length) throw new CatalogError("Request 1-50 distinct supplier inventory products per batch.");
  if (products.length === 1) return [await inventoryState(ids[0], products[0].checkpoint, transport)];
  const response = await transport({ operation: "inventory-sync-batch", ids,
    checkpoints: Object.fromEntries(products.map((product) => [product.supplierId, product.checkpoint])) });
  if (!object(response) || !Array.isArray(response.results) || response.results.length !== ids.length) {
    throw new CatalogError("Supplier returned an incomplete inventory batch; no new checkpoints were accepted.");
  }
  const results = response.results;
  if (results.some((result: unknown) => !object(result) || typeof result.parent_id !== "number" || !ids.includes(result.parent_id)) ||
      new Set(results.map((result: unknown) => object(result) ? result.parent_id : null)).size !== ids.length) {
    throw new CatalogError("Supplier inventory batch identities are invalid or duplicated.");
  }
  return ids.map((id) => results.find((result: unknown) => object(result) && result.parent_id === id));
}
