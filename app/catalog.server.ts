import { execFile } from "node:child_process";

export class CatalogError extends Error {}

type Transport = (request: object) => Promise<unknown>;
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
      reject(new CatalogError("Supplier catalog is unavailable. Retry shortly; no selection or import was changed."));
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

export async function productsPage(filters: object, transport: Transport = sshTransport): Promise<Page<{ products: CatalogProduct[] }>> {
  const data = envelope(await transport({ operation: "products", filters }));
  if (!Array.isArray(data.products) || data.products.length > 50) throw new CatalogError("Supplier catalog exceeded its 50-product page limit.");
  const products: CatalogProduct[] = data.products.map((record: unknown) => {
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
      return { src: image.src, alt: image.alt };
    });
    return {
      id: Number(record.id), parent_id: 0, name: record.name, sku: record.sku, type: record.type,
      price: record.price, currency: record.currency, manage_stock: record.manage_stock,
      stock_quantity: record.stock_quantity, stock_owner_id: record.stock_owner_id === null ? null : Number(record.stock_owner_id),
      images,
    };
  });
  return { products, next_after_id: Number(data.next_after_id), has_more: Boolean(data.has_more) };
}

export async function categoriesPage(after: number, transport: Transport = sshTransport): Promise<Page<{ categories: Category[] }>> {
  const data = envelope(await transport({ operation: "categories", filters: { after_id: after } }));
  if (!Array.isArray(data.categories) || data.categories.length > 50) throw new CatalogError("Supplier category page exceeded its limit.");
  const categories = data.categories.map((record: unknown) => {
    if (!object(record) || !Number.isSafeInteger(record.id) || Number(record.id) < 1 || typeof record.name !== "string") {
      throw new CatalogError("Supplier catalog returned an invalid category.");
    }
    return { id: Number(record.id), name: record.name };
  });
  return { categories, next_after_id: Number(data.next_after_id), has_more: Boolean(data.has_more) };
}

export async function validateSelection(ids: number[], transport: Transport = sshTransport): Promise<void> {
  if (!ids.length) return;
  const data = await transport({ operation: "selection", ids });
  const selected = object(data) ? data.ids : null;
  if (!Array.isArray(selected) || selected.length !== ids.length ||
      !ids.every((id) => selected.includes(id))) {
    throw new CatalogError("Some selected products are no longer published. Refresh the catalog and revise the selection.");
  }
}
