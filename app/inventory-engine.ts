import { ownedProduct, record } from "./import-engine.ts";
import type { GraphQL } from "./import-engine.ts";

export class InventoryError extends Error {}
export class InventoryMutationError extends InventoryError {}
export class InventoryProductMissingError extends InventoryError {
  constructor() {
    super("The linked Shopify product could not be found. Inventory sync is paused. Create a fresh import review to reconnect it or review a replacement, then explicitly enable sync for the verified listing. Any pending stock correction remains protected.");
  }
}
export const INVENTORY_INTERVAL = 5 * 60 * 1000;

export type Mapping = { sourceId: number; variantId: string; inventoryItemId: string };
export type RemoteInventory = Mapping & { onHand: number; committed: number };
export type StockQuantity = { inventoryItemId: string; locationId: string; quantity: number; compareQuantity: number };
export type StockOperation = {
  name: "on_hand"; reason: "correction"; referenceDocumentUri: string; quantities: StockQuantity[];
};
export type Checkpoint = { generation: string; cursor: number };
type SourceStock = {
  id: number; manage_stock: boolean; stock_quantity: number | null;
  stock_owner_id: number | null; stock_status: string;
};
export type InventoryFeed = Checkpoint & {
  parent_id: number; published: boolean; source_ids: number[]; inventory: SourceStock[]; resynced: boolean;
};

function object(value: unknown) {
  if (!record(value)) throw new InventoryError("Invalid inventory response.");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new InventoryError("Invalid inventory list.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new InventoryError("Invalid inventory text.");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new InventoryError("Invalid inventory quantity or identity.");
  }
  return value;
}
function sourceId(value: unknown): number {
  const id = integer(value);
  if (id < 1) throw new InventoryError("Invalid supplier inventory identity.");
  return id;
}
function gid(value: unknown, type: string): string {
  const id = text(value);
  if (!new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`).test(id)) throw new InventoryError(`Invalid Shopify ${type} identity.`);
  return id;
}
function distinct(values: unknown): number[] {
  const ids = list(values).map(sourceId);
  if (ids.length > 2048 || new Set(ids).size !== ids.length) throw new InventoryError("Invalid distinct supplier variant bounds.");
  return ids;
}
export function checkpoint(value: unknown): Checkpoint {
  const data = object(value);
  const generation = text(data.generation);
  const cursor = integer(data.cursor);
  if (!/^[a-f0-9-]{36}$/i.test(generation) || cursor < 0) throw new InventoryError("Invalid supplier inventory checkpoint.");
  return { generation, cursor };
}
export function mappings(value: unknown): Mapping[] {
  const result = list(value).map((entry) => {
    const item = object(entry);
    return { sourceId: sourceId(item.sourceId), variantId: gid(item.variantId, "ProductVariant"), inventoryItemId: gid(item.inventoryItemId, "InventoryItem") };
  });
  if (!result.length || result.length > 2048 ||
      new Set(result.map((item) => item.sourceId)).size !== result.length ||
      new Set(result.map((item) => item.variantId)).size !== result.length ||
      new Set(result.map((item) => item.inventoryItemId)).size !== result.length) {
    throw new InventoryError("Inventory mappings must identify each supplier and Shopify variant exactly once.");
  }
  return result.sort((a, b) => a.sourceId - b.sourceId);
}
export function inventoryFeed(value: unknown, parentId: number, previous: Checkpoint | null): InventoryFeed {
  const data = object(value);
  const next = checkpoint(data);
  const ids = distinct(data.source_ids);
  if (data.parent_id !== parentId || typeof data.published !== "boolean" || typeof data.resynced !== "boolean" ||
      (previous && next.generation === previous.generation && next.cursor < previous.cursor && !data.resynced) ||
      (previous && next.generation !== previous.generation && !data.resynced)) {
    throw new InventoryError("Supplier inventory identity/checkpoint changed without a verified resync.");
  }
  const inventory = list(data.inventory).map((entry): SourceStock => {
    const stock = object(entry);
    const id = sourceId(stock.id);
    if (!ids.includes(id) || typeof stock.manage_stock !== "boolean" ||
        !(stock.stock_quantity === null || typeof stock.stock_quantity === "number") ||
        !(stock.stock_owner_id === null || typeof stock.stock_owner_id === "number") ||
        !["instock", "outofstock", "onbackorder"].includes(text(stock.stock_status))) {
      throw new InventoryError("Supplier returned invalid or unexpected inventory.");
    }
    return { id, manage_stock: stock.manage_stock,
      stock_quantity: stock.stock_quantity === null ? null : integer(stock.stock_quantity),
      stock_owner_id: stock.stock_owner_id === null ? null : sourceId(stock.stock_owner_id),
      stock_status: text(stock.stock_status) };
  });
  if (inventory.length > ids.length || new Set(inventory.map((item) => item.id)).size !== inventory.length ||
      (!data.published && (ids.length || inventory.length))) throw new InventoryError("Supplier returned duplicate or withdrawn inventory records.");
  return { ...next, parent_id: parentId, published: data.published, source_ids: ids, inventory, resynced: data.resynced };
}

export const INVENTORY_QUERY = `query SyncInventoryProduct($id:ID!,$location:ID!,$after:String) {
  product(id:$id) {
    id handle tags supplierId:metafield(namespace:"ultralove_catalog",key:"supplier_id"){value}
    variants(first:100,after:$after) { nodes {
      id supplierId:metafield(namespace:"ultralove_catalog",key:"supplier_id"){value}
      inventoryItem { id tracked inventoryLevel(locationId:$location) {
        quantities(names:["on_hand","committed"]) { name quantity }
      } }
    } pageInfo { hasNextPage endCursor } }
  }
}`;
export const INVENTORY_SET_MUTATION = `mutation SyncInventoryStock($input:InventorySetQuantitiesInput!,$key:String!) {
  inventorySetQuantities(input:$input) @idempotent(key:$key) {
    inventoryAdjustmentGroup { referenceDocumentUri }
    userErrors { field message code }
  }
}`;

async function request(api: GraphQL, query: string, variables: Record<string, unknown>) {
  const response = object(await api(query, variables));
  if (response.errors !== undefined && list(response.errors).length) {
    throw new InventoryError(`Shopify inventory request failed: ${list(response.errors).map((entry) => text(object(entry).message)).join("; ")}`);
  }
  return object(response.data);
}
export async function remoteInventory(api: GraphQL, productId: string, parentId: number, locationId: string): Promise<RemoteInventory[]> {
  gid(productId, "Product");
  gid(locationId, "Location");
  const variants: RemoteInventory[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 21; page++) {
    const data = await request(api, INVENTORY_QUERY, { id: productId, location: locationId, after });
    if (data.product === null) throw new InventoryProductMissingError();
    const product = object(data.product);
    if (product.id !== productId || !ownedProduct({
          handle: text(product.handle), tags: list(product.tags).map(text),
          supplierId: product.supplierId === null ? null : { value: text(object(product.supplierId).value) },
        }, parentId) ||
        object(product.supplierId).value !== String(parentId) ||
        !list(product.tags).includes("ultralove-catalog-import") ||
        !list(product.tags).some((tag) => typeof tag === "string" && /^ultralove-catalog-run-[a-f0-9]{32}$/.test(tag))) {
      throw new InventoryError("Only an app-owned supplier product can be enrolled. Legacy test listings must be replaced through the current import flow.");
    }
    const connection = object(product.variants);
    const nodes = list(connection.nodes);
    if (nodes.length > 100) throw new InventoryError("Shopify inventory page exceeded its limit.");
    for (const entry of nodes) {
      const variant = object(entry);
      const source = text(object(variant.supplierId).value);
      if (!/^[1-9]\d*$/.test(source)) throw new InventoryError("Shopify variant lost its supplier identity.");
      const item = object(variant.inventoryItem);
      if (item.tracked !== true) throw new InventoryError("Shopify inventory tracking is disabled; review before enabling sync.");
      const levels = list(object(item.inventoryLevel).quantities).map(object);
      const quantity = (name: string) => {
        const matches = levels.filter((level) => level.name === name);
        if (matches.length !== 1) throw new InventoryError(`Shopify did not return exactly one ${name} quantity.`);
        return integer(matches[0].quantity);
      };
      const committed = quantity("committed");
      if (committed < 0) throw new InventoryError("Shopify returned invalid reserved order stock.");
      variants.push({ sourceId: sourceId(Number(source)), variantId: gid(variant.id, "ProductVariant"),
        inventoryItemId: gid(item.id, "InventoryItem"), onHand: quantity("on_hand"), committed });
    }
    if (variants.length > 2048) throw new InventoryError("Shopify variant inventory exceeded its limit.");
    const info = object(connection.pageInfo);
    if (info.hasNextPage === false) {
      mappings(variants);
      return variants.sort((a, b) => a.sourceId - b.sourceId);
    }
    const cursor = text(info.endCursor);
    if (info.hasNextPage !== true || !cursor || cursors.has(cursor) || !nodes.length) throw new InventoryError("Shopify inventory pagination did not advance.");
    cursors.add(cursor);
    after = cursor;
  }
  throw new InventoryError("Shopify inventory pagination exceeded its review limit.");
}
export function verifyMappings(saved: Mapping[], current: RemoteInventory[]) {
  if (JSON.stringify(mappings(saved)) !== JSON.stringify(mappings(current))) {
    throw new InventoryError("Shopify variants or inventory identities changed. Pause sync and review the mapping; no stock was changed.");
  }
}
export function stockPlan(current: RemoteInventory[], feed: InventoryFeed, locationId: string) {
  gid(locationId, "Location");
  const warnings: string[] = [];
  if (!feed.published) warnings.push("Supplier product withdrawn: mapped stock is zero.");
  if (feed.source_ids.some((id) => !current.some((item) => item.sourceId === id))) {
    warnings.push("New supplier variants require a separate import/review; no variants were added.");
  }
  const desired = current.map((item) => {
    const stock = feed.inventory.find((entry) => entry.id === item.sourceId);
    let quantity = 0;
    if (!stock) {
      if (feed.published) warnings.push(`Supplier variant ${item.sourceId} is unavailable: stock is zero.`);
    } else if (!stock.manage_stock || stock.stock_quantity === null || stock.stock_owner_id !== stock.id) {
      warnings.push(`Supplier variant ${item.sourceId} has unknown, unmanaged or shared stock: stock is zero until reviewed.`);
    } else if (stock.stock_status !== "outofstock") {
      quantity = Math.max(0, stock.stock_quantity);
    }
    if (quantity < item.committed) warnings.push(`Supplier variant ${item.sourceId} has less stock than Shopify reserved orders: fulfillment requires review.`);
    return { inventoryItemId: item.inventoryItemId, locationId, quantity, compareQuantity: item.onHand };
  });
  return { desired, changed: desired.filter((item) => item.quantity !== item.compareQuantity), warnings };
}
export function stockOperation(value: unknown): StockOperation {
  const operation = object(value);
  const quantities = list(operation.quantities).map((entry): StockQuantity => {
    const item = object(entry);
    const quantity = integer(item.quantity);
    if (quantity < 0) throw new InventoryError("Stock corrections cannot invent negative on-hand units.");
    return { inventoryItemId: gid(item.inventoryItemId, "InventoryItem"), locationId: gid(item.locationId, "Location"),
      quantity, compareQuantity: integer(item.compareQuantity) };
  });
  if (operation.name !== "on_hand" || operation.reason !== "correction" ||
      !/^gid:\/\/ultralove\/InventorySync\/[a-f0-9]{32}$/.test(text(operation.referenceDocumentUri)) ||
      !quantities.length || quantities.length > 250 ||
      new Set(quantities.map((item) => item.inventoryItemId)).size !== quantities.length) {
    throw new InventoryError("Invalid bounded inventory correction.");
  }
  return { name: "on_hand", reason: "correction", referenceDocumentUri: text(operation.referenceDocumentUri), quantities };
}
export async function setStock(api: GraphQL, value: StockOperation, key: string) {
  if (!/^[a-f0-9]{32}$/.test(key)) throw new InventoryError("Invalid persisted inventory idempotency key.");
  const input = stockOperation(value);
  // Preserve saved corrections while adapting the renamed Shopify API field.
  const requestInput = { ...input, quantities: input.quantities.map(({ compareQuantity, ...quantity }) => ({
    ...quantity, changeFromQuantity: compareQuantity,
  })) };
  const result = object((await request(api, INVENTORY_SET_MUTATION, { input: requestInput, key })).inventorySetQuantities);
  const errors = list(result.userErrors);
  if (errors.length) throw new InventoryMutationError(`Shopify rejected the stock correction: ${errors.map((entry) => text(object(entry).message)).join("; ")}`);
  if (object(result.inventoryAdjustmentGroup).referenceDocumentUri !== input.referenceDocumentUri) {
    throw new InventoryError("Shopify did not acknowledge the persisted inventory correction. Retry reconciliation.");
  }
}
