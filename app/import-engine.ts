import { markupPercent as normalizeMarkup, PricingError } from "./pricing-policy.ts";
import type { FulfillmentMode } from "./fulfillment-policy.ts";

export class ImportError extends Error {}
export type GraphQL = (query: string, variables: Record<string, unknown>) => Promise<unknown>;
type Metadata = { namespace: string; key: string; value: string };
type Variant = {
  sku: string; price: string; barcode?: string; inventoryPolicy: string;
  inventoryItem: { tracked: boolean };
  inventoryQuantities?: { locationId: string; name: string; quantity: number }[];
  metafields: Metadata[];
};
export type Payload = Record<string, unknown> & {
  title: string; handle: string; status: "DRAFT"; tags: string[];
  variants: Variant[]; metafields: Metadata[];
};
export type PlannedItem = { supplierId: number; name: string; sku: string; wholesale: (string | null)[]; payload: Payload };
export type RemoteProduct = {
  id: string; handle: string; status: string; tags: string[];
  supplierId: { value: string } | null; variants: { nodes: { sku: string; price: string }[] };
};
export const MAX_PREVIEW_AGE = 10 * 60 * 1000;
export const IMAGE_READY_ATTEMPTS = 10;
export const IMAGE_READY_INTERVAL_MS = 2000;
export type ImportSettings = { active: boolean; publicationId: string | null };

export function importChoices(form: FormData) {
  const checked = (name: string) => {
    const values = form.getAll(name);
    if (values.length > 1 || (values.length === 1 && values[0] !== "yes")) {
      throw new ImportError(`Invalid ${name} import setting.`);
    }
    return values.length === 1;
  };
  const active = checked("active");
  const publish = checked("publish");
  if (publish && !active) throw new ImportError("Publishing requires Active product status.");
  return { active, publish };
}

export function importSettings(active: unknown, publicationId: unknown): ImportSettings {
  if (typeof active !== "boolean" || !(publicationId === null ||
      (typeof publicationId === "string" && /^gid:\/\/shopify\/Publication\/[1-9]\d*$/.test(publicationId))) ||
      (!active && publicationId !== null)) throw new ImportError("Invalid saved import visibility settings.");
  return { active, publicationId };
}

export function importConfirmation(settings: ImportSettings) {
  return settings.publicationId ? "publish-online-store" : settings.active ? "active-only" : "draft-only";
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown) {
  if (!record(value)) throw new ImportError("Invalid Shopify or supplier response.");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ImportError("Invalid Shopify or supplier list.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new ImportError("Invalid Shopify or supplier text.");
  return value;
}
function metadata(value: unknown): Metadata[] {
  return list(value).map((entry) => {
    const field = object(entry);
    return { ...field, namespace: text(field.namespace), key: text(field.key), value: text(field.value) };
  });
}

export function markupPercent(value: unknown): string {
  try {
    return normalizeMarkup(value);
  } catch (error) {
    if (!(error instanceof PricingError)) throw error;
    throw new ImportError(error.message);
  }
}
export function cadCents(value: string): bigint {
  if (value.length > 128 || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new ImportError("Invalid CAD price.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export function priceRange(prices: (string | null)[]): string {
  const valid = [...new Set(prices.filter((price): price is string => price !== null && price !== ""))];
  if (!valid.length) return "Missing price - review required";
  if (valid.some((price) => price.length > 128 || !/^\d+(?:\.\d+)?$/.test(price) || !Number.isFinite(Number(price)))) {
    throw new ImportError("Invalid supplier or retail CAD price.");
  }
  valid.sort((a, b) => Number(a) - Number(b));
  return `${valid[0]}${valid.length > 1 ? ` - ${valid.at(-1)}` : ""} CAD${valid.length !== prices.length && prices.some((price) => !price) ? " (some missing)" : ""}`;
}

export function payload(value: unknown, supplierId: number, runId: string, location: string, mode: FulfillmentMode = "DROPSHIPPING"): Payload {
  const input = object(value);
  const allowed = ["title", "descriptionHtml", "handle", "status", "vendor", "tags", "productOptions", "variants", "metafields", "files"];
  if (Object.keys(input).some((key) => !allowed.includes(key)) || input.status !== "DRAFT" ||
      input.handle !== `ultralove-catalog-${supplierId}` || !text(input.title).trim() ||
      !/^[a-f0-9]{32}$/.test(runId)) throw new ImportError("Import payload must create an owned unpublished draft.");
  const tags = list(input.tags).map(text);
  const fields = metadata(input.metafields);
  if (!tags.includes("ultralove-catalog-import") || !tags.includes(`ultralove-catalog-run-${runId}`) ||
      !fields.some((field) => field.namespace === "ultralove_catalog" && field.key === "supplier_id" && field.value === String(supplierId))) {
    throw new ImportError("Import payload has an invalid supplier identity.");
  }
  const variants = list(input.variants).map((entry): Variant => {
    const variant = object(entry);
    const inventory = object(variant.inventoryItem);
    if (mode === "CATALOG" && variant.inventoryQuantities !== undefined) throw new ImportError("Catalog-only imports must not contain supplier inventory quantities.");
    const quantities = mode === "CATALOG" ? [] : list(variant.inventoryQuantities).map((entry) => {
      const quantity = object(entry);
      if (quantity.locationId !== location || quantity.name !== "available" ||
          !Number.isInteger(quantity.quantity) || Number(quantity.quantity) < 0 || Number(quantity.quantity) > 2147483647) {
        throw new ImportError("Import inventory must use the approved location and real nonnegative quantities.");
      }
      return { ...quantity, locationId: location, name: "available", quantity: Number(quantity.quantity) };
    });
    const price = text(variant.price);
    cadCents(price);
    if ("id" in variant || "id" in inventory || inventory.tracked !== true ||
        variant.inventoryPolicy !== "DENY" || (mode === "DROPSHIPPING" && quantities.length !== 1) ||
        (variant.barcode !== undefined && typeof variant.barcode !== "string")) throw new ImportError("Unsafe import variant.");
    return { ...variant, sku: text(variant.sku), price, inventoryPolicy: "DENY",
      inventoryItem: { ...inventory, tracked: true }, ...(mode === "DROPSHIPPING" ? { inventoryQuantities: quantities } : {}),
      metafields: metadata(variant.metafields) };
  });
  if (!variants.length || variants.length > 2048) throw new ImportError("Import requires 1-2048 variants per parent.");
  return { ...input, title: text(input.title), handle: text(input.handle), status: "DRAFT", tags, variants, metafields: fields };
}

export function catalogOnlyPayload(input: Payload): Payload {
  return { ...input, variants: input.variants.map((variant) => {
    const copy = { ...variant };
    delete copy.inventoryQuantities;
    return copy;
  }) };
}

export function plannedFeed(value: unknown, ids: number[], runId: string, location: string) {
  const feed = object(value);
  if (!ids.length || new Set(ids).size !== ids.length ||
      !ids.every((id) => Number.isSafeInteger(id) && id > 0) ||
      typeof feed.generation !== "string" || !/^[a-f0-9-]{36}$/i.test(feed.generation) ||
      !Number.isSafeInteger(feed.cursor) || Number(feed.cursor) < 0) throw new ImportError("Invalid import checkpoint.");
  const items = list(feed.items).map((entry): PlannedItem => {
    const item = object(entry);
    if (!ids.includes(Number(item.supplierId)) || typeof item.supplierId !== "number") throw new ImportError("Unexpected supplier product in import plan.");
    const input = payload(item.payload, item.supplierId, runId, location);
    const wholesale = list(item.wholesale).map((price) => price === null ? null : text(price));
    if (wholesale.length !== input.variants.length) throw new ImportError("Incomplete variant pricing preview.");
    priceRange(wholesale);
    return { supplierId: item.supplierId, name: text(item.name), sku: text(item.sku), wholesale, payload: input };
  });
  if (items.length !== ids.length || new Set(items.map((item) => item.supplierId)).size !== ids.length) {
    throw new ImportError("Import plan must include every selected parent exactly once.");
  }
  return { generation: feed.generation, cursor: Number(feed.cursor), items };
}
export function reviewLabels(input: Payload): string[] {
  return input.tags.filter((tag) => tag.startsWith("ultralove-review-")).map((tag) => tag.slice("ultralove-review-".length));
}

export const CONTEXT_QUERY = `query ImportContext {
  shop { myshopifyDomain currencyCode }
  locations(first:100) { nodes { id name isActive fulfillsOnlineOrders } pageInfo { hasNextPage } }
}`;
export const CATALOG_QUERY = `query ImportCatalog($after:String) {
  products(first:100,after:$after) { nodes {
    id handle status tags supplierId:metafield(namespace:"ultralove_catalog",key:"supplier_id"){value}
    variants(first:2){nodes{sku price}}
  } pageInfo { hasNextPage endCursor } }
}`;
export const CREATE_MUTATION = `mutation ImportDraft($input:ProductSetInput!) {
  productSet(input:$input,synchronous:true) { product {
    id handle status tags supplierId:metafield(namespace:"ultralove_catalog",key:"supplier_id"){value}
    variants(first:1){nodes{sku price}}
  } userErrors { field message } }
}`;
export const VERIFY_QUERY = `query VerifyDraft($id:ID!,$after:String,$location:ID!) {
  product(id:$id) { status variants(first:100,after:$after) {
    nodes { sku price barcode inventoryPolicy supplierId:metafield(namespace:"ultralove_catalog",key:"supplier_id"){value}
      inventoryItem { tracked inventoryLevel(locationId:$location) { quantities(names:["available"]){name quantity} } }
    } pageInfo { hasNextPage endCursor }
  } }
}`;

export const PUBLICATIONS_QUERY = `query ImportOnlineStorePublication {
  currentAppInstallation { accessScopes { handle } }
  publications(first:100,catalogType:APP) {
    nodes { id catalog { ... on AppCatalog { apps(first:10) { nodes { title } pageInfo { hasNextPage } } } } }
    pageInfo { hasNextPage }
  }
}`;
export const ACTIVATE_MUTATION = `mutation ActivateImportedProduct($product:ProductUpdateInput!) {
  productUpdate(product:$product) { product { id status } userErrors { field message } }
}`;
export const PUBLICATION_STATE_QUERY = `query ImportPublicationState($id:ID!,$publicationId:ID!) {
  product(id:$id) {
    id status publishedOnPublication(publicationId:$publicationId)
    media(first:250) { nodes { status } pageInfo { hasNextPage } }
  }
}`;
export const PUBLISH_MUTATION = `mutation PublishImportedProduct($id:ID!,$input:[PublicationInput!]!) {
  publishablePublish(id:$id,input:$input) { userErrors { field message } }
}`;

// Product metafield ultralove.dropshipping (boolean): true when the product is
// imported for dropshipping, false when it is listed from the catalog only.
// Storefront-readable so themes and other apps can branch on it.
export const DROPSHIPPING_NAMESPACE = "ultralove";
export const DROPSHIPPING_KEY = "dropshipping";
export const DROPSHIPPING_DEFINITION = {
  name: "Dropshipping", namespace: DROPSHIPPING_NAMESPACE, key: DROPSHIPPING_KEY, type: "boolean", ownerType: "PRODUCT",
  description: "True when UltraLove ships this product to the customer (dropshipping); false when it is listed from the catalog only.",
  access: { storefront: "PUBLIC_READ" },
};
export const DROPSHIPPING_DEFINITION_MUTATION = `mutation DropshippingDefinition($definition:MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition:$definition) { createdDefinition { id } userErrors { field message code } }
}`;
export const DROPSHIPPING_MUTATION = `mutation ImportDropshipping($metafields:[MetafieldsSetInput!]!) {
  metafieldsSet(metafields:$metafields) { userErrors { field message } }
}`;

async function request(api: GraphQL, query: string, variables: Record<string, unknown> = {}) {
  const response = object(await api(query, variables));
  if (response.errors !== undefined && list(response.errors).length) throw new ImportError("Shopify rejected the request. Retry after checking API access or rate limits.");
  return object(response.data);
}
export async function onlineStorePublication(api: GraphQL): Promise<string> {
  const response = object(await api(PUBLICATIONS_QUERY, {}));
  if (response.errors !== undefined && list(response.errors).length) {
    throw new ImportError("Online Store publication lookup failed. Check read_publications/write_publications permissions and API limits; reopen the app after authorizing the new scopes.");
  }
  const data = object(response.data);
  const scopes = list(object(data.currentAppInstallation).accessScopes).map((scope) => text(object(scope).handle));
  if (!scopes.includes("write_publications")) {
    throw new ImportError("Publishing requires read_publications and write_publications. Authorize both scopes and reopen the app before retrying.");
  }
  const publications = object(data.publications);
  if (object(publications.pageInfo).hasNextPage !== false) throw new ImportError("Sales channel pagination requires operator review.");
  const matches = list(publications.nodes).map(object).filter((publication) => {
    if (publication.catalog === null) return false;
    const apps = object(object(publication.catalog).apps);
    if (object(apps.pageInfo).hasNextPage !== false) throw new ImportError("Sales channel app pagination requires operator review.");
    return list(apps.nodes).map(object).some((app) => app.title === "Online Store");
  });
  if (matches.length !== 1) throw new ImportError("Exactly one Online Store publication is required. No other channel will be used.");
  const id = text(matches[0].id);
  importSettings(true, id);
  return id;
}

async function finishNewProduct(api: GraphQL, input: Payload, product: RemoteProduct, settings: ImportSettings, location?: string) {
  if (!settings.active) return;
  if (product.status !== "DRAFT" && product.status !== "ACTIVE") {
    throw new ImportError("Imported product status changed unexpectedly. Manual review is required.");
  }
  const publicationId = settings.publicationId;
  let published = false;
  if (publicationId) {
    const expectedImages = input.files === undefined ? 0 : list(input.files).length;
    let waitedForImages = false;
    for (let attempt = 0; attempt < IMAGE_READY_ATTEMPTS; attempt++) {
      const state = object((await request(api, PUBLICATION_STATE_QUERY, { id: product.id, publicationId })).product);
      if (state.id !== product.id || state.status !== product.status || typeof state.publishedOnPublication !== "boolean") {
        throw new ImportError("Imported product publication state changed unexpectedly. Manual review is required.");
      }
      published = state.publishedOnPublication;
      if (published) break;
      const media = object(state.media);
      const images = list(media.nodes).map(object);
      if (object(media.pageInfo).hasNextPage !== false || images.length > expectedImages) {
        throw new ImportError("Product images do not match the reviewed import. Review images in Shopify, then retry; the product was not published.");
      }
      if (images.some((image) => image.status === "FAILED")) {
        throw new ImportError("Product images failed processing in Shopify. Review images in Shopify, then retry; the product was not published.");
      }
      if (images.some((image) => !["READY", "UPLOADED", "PROCESSING"].includes(text(image.status)))) {
        throw new ImportError("Product images have an unexpected processing status. Review images in Shopify; the product was not published.");
      }
      if (images.length === expectedImages && images.every((image) => image.status === "READY")) {
        break;
      }
      if (attempt === IMAGE_READY_ATTEMPTS - 1) {
        throw new ImportError(images.length < expectedImages
          ? "Expected product images are still missing in Shopify after waiting. Review images, then retry; the product was not published."
          : "Shopify is still processing product images after waiting. Retry shortly; the product was not published.");
      }
      if (attempt === 0) console.info("Waiting for Shopify product images.", product.id);
      waitedForImages = true;
      await new Promise<void>((resolve) => setTimeout(resolve, IMAGE_READY_INTERVAL_MS));
    }
    if (waitedForImages) await verifyDraft(api, input, product.id, product.status === "ACTIVE" ? "ACTIVE" : "DRAFT", location);
  }
  if (product.status === "DRAFT") {
    const result = object((await request(api, ACTIVATE_MUTATION, { product: { id: product.id, status: "ACTIVE" } })).productUpdate);
    const errors = list(result.userErrors);
    if (errors.length) throw new ImportError(`Product activation requires review: ${errors.map((entry) => text(object(entry).message)).join("; ")}`);
    const active = object(result.product);
    if (active.id !== product.id || active.status !== "ACTIVE") throw new ImportError("Shopify did not confirm Active product status.");
  }
  if (publicationId) {
    if (!published) {
      const result = object((await request(api, PUBLISH_MUTATION, {
        id: product.id, input: [{ publicationId }],
      })).publishablePublish);
      const errors = list(result.userErrors);
      if (errors.length) throw new ImportError(`Online Store publication requires review: ${errors.map((entry) => text(object(entry).message)).join("; ")}`);
    }
    const state = object((await request(api, PUBLICATION_STATE_QUERY, { id: product.id, publicationId })).product);
    if (state.id !== product.id || state.status !== "ACTIVE" || state.publishedOnPublication !== true) {
      throw new ImportError("Shopify did not confirm Active status and Online Store publication. Retry reconciliation; no duplicate will be created.");
    }
  }
}
export async function shopContext(api: GraphQL, shop: string) {
  const data = await request(api, CONTEXT_QUERY);
  const info = object(data.shop);
  if (info.myshopifyDomain !== shop || info.currencyCode !== "CAD") throw new ImportError("Draft imports require the approved test store with CAD currency.");
  const locations = object(data.locations);
  if (object(locations.pageInfo).hasNextPage !== false) throw new ImportError("Location pagination requires operator review.");
  const matches = list(locations.nodes).map(object).filter((location) => location.name === "Shop location" && location.isActive === true && location.fulfillsOnlineOrders === true);
  if (matches.length !== 1 || !/^gid:\/\/shopify\/Location\/\d+$/.test(text(matches[0].id))) throw new ImportError("Exactly one active merchant Shop location is required.");
  return text(matches[0].id);
}
function remoteProduct(value: unknown): RemoteProduct {
  const product = object(value);
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(text(product.id))) throw new ImportError("Invalid Shopify product identity.");
  return { id: text(product.id), handle: text(product.handle), status: text(product.status), tags: list(product.tags).map(text),
    supplierId: product.supplierId === null ? null : { value: text(object(product.supplierId).value) },
    variants: { nodes: list(object(product.variants).nodes).map((entry) => {
      const variant = object(entry);
      return { sku: variant.sku === null ? "" : text(variant.sku), price: text(variant.price) };
    }) } };
}
export async function remoteCatalog(api: GraphQL): Promise<RemoteProduct[]> {
  const products: RemoteProduct[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const connection = object((await request(api, CATALOG_QUERY, { after })).products);
    products.push(...list(connection.nodes).map(remoteProduct));
    const page = object(connection.pageInfo);
    if (page.hasNextPage === false) return products;
    const cursor = text(page.endCursor);
    if (page.hasNextPage !== true || !cursor || cursors.has(cursor) || products.length >= 10000) throw new ImportError("Shopify catalog pagination requires operator review.");
    cursors.add(cursor);
    after = cursor;
  }
  throw new ImportError("Shopify catalog exceeds the bounded review limit.");
}
export function ownedProduct(product: Pick<RemoteProduct, "handle" | "supplierId" | "tags">, supplierId: number) {
  const canonical = /^ultralove-catalog-([1-9]\d*)$/.exec(product.handle);
  return (!canonical || canonical[1] === String(supplierId)) &&
    (product.handle === `ultralove-catalog-${supplierId}` || product.tags.includes("ultralove-catalog-linked")) &&
    product.supplierId?.value === String(supplierId) && product.tags.includes("ultralove-catalog-import") &&
    product.tags.some((tag) => /^ultralove-catalog-run-[a-f0-9]{32}$/.test(tag));
}
export function matchProduct(products: RemoteProduct[], supplierId: number): RemoteProduct | null {
  const matches = new Map<string, RemoteProduct>();
  for (const product of products) {
    if (product.handle === `ultralove-catalog-${supplierId}` || product.supplierId?.value === String(supplierId)) {
      if (!ownedProduct(product, supplierId) ||
          !product.tags.includes("ultralove-catalog-import") || !product.tags.some((tag) => /^ultralove-catalog-run-[a-f0-9]{32}$/.test(tag))) {
        throw new ImportError(`Supplier identity collision for ${supplierId}; no listing was changed.`);
      }
      matches.set(product.id, product);
    }
  }
  if (matches.size > 1) throw new ImportError(`Duplicate Shopify supplier identities for ${supplierId}.`);
  return [...matches.values()][0] || null;
}
export async function verifyDraft(api: GraphQL, input: Payload, productId: string, expectedStatus: "DRAFT" | "ACTIVE" = "DRAFT", location?: string) {
  const wanted = new Map(input.variants.map((variant) => {
    const supplier = variant.metafields.find((field) => field.namespace === "ultralove_catalog" && field.key === "supplier_id");
    if (!supplier || !/^[1-9]\d*$/.test(supplier.value)) throw new ImportError("Missing supplier variant identity.");
    return [supplier.value, variant];
  }));
  if (wanted.size !== input.variants.length) throw new ImportError("Duplicate supplier variant identity.");
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  let complete = false;
  const inventoryLocation = input.variants[0].inventoryQuantities?.[0]?.locationId ?? location;
  if (!inventoryLocation) throw new ImportError("The reviewed inventory location is required for draft verification.");
  for (let pageNumber = 0; pageNumber < 21; pageNumber++) {
    const product = object((await request(api, VERIFY_QUERY, { id: productId, after, location: inventoryLocation })).product);
    if (product.status !== expectedStatus) throw new ImportError("The imported product has an unexpected status; manual review required.");
    const variants = object(product.variants);
    for (const entry of list(variants.nodes)) {
      const variant = object(entry);
      const id = text(object(variant.supplierId).value);
      const expected = wanted.get(id);
      const inventory = object(variant.inventoryItem);
      const quantities = inventory.inventoryLevel === null ? [] : list(object(inventory.inventoryLevel).quantities).map(object);
      const expectedQuantity = expected?.inventoryQuantities?.[0]?.quantity;
      const validInventory = expectedQuantity === undefined
        ? quantities.length === 0 || (quantities.length === 1 && quantities[0].name === "available" && quantities[0].quantity === 0)
        : quantities.length === 1 && quantities[0].name === "available" && quantities[0].quantity === expectedQuantity;
      if (!expected || seen.has(id) || (variant.sku === null ? "" : text(variant.sku)) !== expected.sku || cadCents(text(variant.price)) !== cadCents(expected.price) ||
          (variant.barcode || null) !== (expected.barcode || null) || variant.inventoryPolicy !== "DENY" || inventory.tracked !== true ||
          !validInventory) {
        throw new ImportError("Created draft failed variant, price, barcode or inventory verification. No repair was applied.");
      }
      seen.add(id);
    }
    const page = object(variants.pageInfo);
    if (page.hasNextPage === false) {
      complete = true;
      break;
    }
    const cursor = text(page.endCursor);
    if (page.hasNextPage !== true || !cursor || cursors.has(cursor) || seen.size >= 2048) throw new ImportError("Draft variant pagination failed verification.");
    cursors.add(cursor);
    after = cursor;
  }
  if (!complete || seen.size !== wanted.size) throw new ImportError("Created draft omitted source variants or incomplete pagination.");
}

export async function importDraft(options: {
  api: GraphQL; products: RemoteProduct[]; input: Payload; supplierId: number; runId: string;
  attempted: boolean; previouslyMapped: boolean; expectedProductId?: string | null; fresh: boolean; beforeMutation: () => Promise<void>;
  active?: boolean; publicationId?: string | null;
  location?: string;
  onCreated?: (productId: string) => Promise<void>;
}): Promise<{ status: "CREATED" | "REUSED"; productId: string }> {
  const { api, products, input, supplierId, runId } = options;
  const settings = importSettings(options.active ?? false, options.publicationId ?? null);
  const existing = matchProduct(products, supplierId);
  if (existing) {
    if (options.expectedProductId && existing.id !== options.expectedProductId) throw new ImportError("The saved Shopify mapping was replaced. Manual review is required.");
    if (existing.tags.includes(`ultralove-catalog-run-${runId}`)) {
      await options.onCreated?.(existing.id);
      await verifyDraft(api, input, existing.id, settings.active && existing.status === "ACTIVE" ? "ACTIVE" : "DRAFT", options.location);
      await finishNewProduct(api, input, existing, settings, options.location);
      return { status: "CREATED", productId: existing.id };
    }
    return { status: "REUSED", productId: existing.id };
  }
  if (options.attempted) throw new ImportError("A previous creation may have reached Shopify. Reconciliation found no owned listing; manual review is required before another creation.");
  if (options.previouslyMapped) throw new ImportError("The previously mapped listing was removed. Automatic recreation is blocked.");
  if (!options.fresh) throw new ImportError("Pricing preview expired. Create a fresh preview before importing new drafts.");
  // Persist the cross-job claim before the only mutation; uncertain responses never authorize a second creation.
  await options.beforeMutation();
  const set = object((await request(api, CREATE_MUTATION, { input })).productSet);
  const errors = list(set.userErrors);
  if (errors.length) throw new ImportError(`Shopify draft creation requires review: ${errors.map((entry) => text(object(entry).message)).join("; ")}`);
  const created = remoteProduct(set.product);
  if (matchProduct([created], supplierId)?.id !== created.id || !created.tags.includes(`ultralove-catalog-run-${runId}`) || created.status !== "DRAFT") {
    throw new ImportError("Shopify creation returned an unexpected identity or publication status.");
  }
  await options.onCreated?.(created.id);
  await verifyDraft(api, input, created.id, "DRAFT", options.location);
  await finishNewProduct(api, input, created, settings, options.location);
  products.push({ ...created, status: settings.active ? "ACTIVE" : "DRAFT" });
  return { status: "CREATED", productId: created.id };
}
