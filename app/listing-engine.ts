import { createHash } from "node:crypto";
import { parseFragment, serialize } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { cadCents, ImportError, MAX_PREVIEW_AGE, ownedProduct, record } from "./import-engine.ts";
import type { GraphQL, Payload } from "./import-engine.ts";
import type { ListingPolicy } from "./listing-policy.ts";

export type ListingReview = {
  action: "CREATE" | "KEEP" | "UPDATE" | "LINK" | "RECREATE" | "BLOCKED";
  targetId: string | null;
  changes: { field: string; before: string; after: string }[];
  message: string | null;
};
type SupplierField = { value: string; compareDigest: string } | null;
type ListingVariant = {
  id: string; sku: string | null; price: string; compareAtPrice: string | null;
  barcode: string | null; inventoryPolicy: string; selectedOptions: { name: string; value: string }[];
  inventoryItem: { id: string; tracked: boolean }; supplierId: SupplierField;
};
export type ListingSnapshot = {
  id: string; title: string; descriptionHtml: string; vendor: string; handle: string;
  status: string; tags: string[]; updatedAt: string; supplierId: SupplierField;
  variants: ListingVariant[];
  media: { id: string; alt: string | null; status: string; image: { url: string } | null }[];
};
export type ListingWork = {
  baseline?: ListingSnapshot;
  capturedAt?: number;
  expectedProductId?: string | null;
  expectedClaimRun?: string | null;
  variantIds?: string[];
  started?: string[];
  replacementReserved?: boolean;
};

export const LISTING_QUERY = `query ReviewSupplierListing($id:ID!,$after:String) {
  product(id:$id) {
    id title descriptionHtml vendor handle status tags updatedAt
    supplierId:metafield(namespace:"ultralove_catalog",key:"supplier_id"){value compareDigest}
    media(first:250){nodes{id alt status ... on MediaImage {image{url}}} pageInfo{hasNextPage}}
    variants(first:100,after:$after){nodes{
      id sku price compareAtPrice barcode inventoryPolicy selectedOptions{name value}
      inventoryItem{id tracked}
      supplierId:metafield(namespace:"ultralove_catalog",key:"supplier_id"){value compareDigest}
    } pageInfo{hasNextPage endCursor}}
  }
}`;
export const LISTING_UPDATE_MUTATION = `mutation RefreshSupplierContent($product:ProductUpdateInput!,$media:[CreateMediaInput!]) {
  productUpdate(product:$product,media:$media){product{id} userErrors{field message}}
}`;
export const LISTING_PRICES_MUTATION = `mutation RefreshSupplierPrices($id:ID!,$variants:[ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId:$id,variants:$variants,allowPartialUpdates:false){
    productVariants{id price} userErrors{field message}
  }
}`;
export const LISTING_METADATA_MUTATION = `mutation LinkSupplierIdentity($metafields:[MetafieldsSetInput!]!) {
  metafieldsSet(metafields:$metafields){metafields{id} userErrors{field message}}
}`;
export const LISTING_TAGS_MUTATION = `mutation MarkSupplierLink($id:ID!,$tags:[String!]!) {
  tagsAdd(id:$id,tags:$tags){node{id} userErrors{field message}}
}`;

function object(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new ImportError("Invalid Shopify listing response.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new ImportError("Invalid Shopify listing text.");
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function supplierField(value: unknown): SupplierField {
  if (value === null) return null;
  const field = object(value);
  return { value: text(field.value), compareDigest: text(field.compareDigest) };
}
function variantSnapshot(value: unknown): ListingVariant {
  const variant = object(value);
  const inventory = object(variant.inventoryItem);
  const id = text(variant.id);
  const inventoryId = text(inventory.id);
  const price = text(variant.price);
  const compareAtPrice = nullableText(variant.compareAtPrice);
  cadCents(price);
  if (compareAtPrice !== null) cadCents(compareAtPrice);
  if (!/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(id) ||
      !/^gid:\/\/shopify\/InventoryItem\/[1-9]\d*$/.test(inventoryId) ||
      typeof inventory.tracked !== "boolean" || !Array.isArray(variant.selectedOptions) ||
      !["DENY", "CONTINUE"].includes(text(variant.inventoryPolicy))) {
    throw new ImportError("Incomplete Shopify variant snapshot.");
  }
  return {
    id, sku: nullableText(variant.sku), price, compareAtPrice, barcode: nullableText(variant.barcode),
    inventoryPolicy: text(variant.inventoryPolicy), inventoryItem: { id: inventoryId, tracked: inventory.tracked },
    supplierId: supplierField(variant.supplierId),
    selectedOptions: variant.selectedOptions.map((entry) => {
      const option = object(entry);
      return { name: text(option.name), value: text(option.value) };
    }),
  };
}
function mediaSnapshot(value: unknown): ListingSnapshot["media"][number] {
  const media = object(value);
  const id = text(media.id);
  if (!/^gid:\/\/shopify\/[A-Za-z0-9]+\/[1-9]\d*$/.test(id)) throw new ImportError("Invalid Shopify media identity.");
  return {
    id, alt: nullableText(media.alt), status: text(media.status),
    image: media.image === undefined || media.image === null ? null : { url: text(object(media.image).url) },
  };
}
async function request(api: GraphQL, query: string, variables: Record<string, unknown>) {
  const response = object(await api(query, variables));
  if (response.errors) throw new ImportError("Shopify listing request failed. No blind retry was applied.");
  return object(response.data);
}
export async function listingSnapshot(api: GraphQL, id: string): Promise<ListingSnapshot | null> {
  const variants: ListingVariant[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  let result: ListingSnapshot | undefined;
  for (let page = 0; page < 21; page++) {
    const data = await request(api, LISTING_QUERY, { id, after });
    if (data.product === null && page === 0) return null;
    const product = object(data.product);
    const connection = object(product.variants);
    const media = object(product.media);
    if (product.id !== id || !Array.isArray(connection.nodes) || !Array.isArray(media.nodes) ||
        object(media.pageInfo).hasNextPage !== false ||
        ["title", "descriptionHtml", "vendor", "handle", "status", "updatedAt"].some((key) => typeof product[key] !== "string") ||
        !Array.isArray(product.tags) || product.tags.some((tag) => typeof tag !== "string")) {
      throw new ImportError("Incomplete Shopify listing snapshot. Review pagination and product identity.");
    }
    const current: ListingSnapshot = {
      id, title: text(product.title), descriptionHtml: text(product.descriptionHtml), vendor: text(product.vendor),
      handle: text(product.handle), status: text(product.status), tags: product.tags.map(text),
      updatedAt: text(product.updatedAt), supplierId: supplierField(product.supplierId),
      variants: [], media: media.nodes.map(mediaSnapshot),
    };
    if (result && JSON.stringify({ ...result, variants: [] }) !== JSON.stringify(current)) {
      throw new ImportError("Shopify listing changed during review. Create a fresh preview.");
    }
    result = current;
    variants.push(...connection.nodes.map(variantSnapshot));
    if (variants.length > 2048 || new Set(variants.map((variant) => variant.id)).size !== variants.length) {
      throw new ImportError("Duplicate or excessive Shopify variants.");
    }
    const info = object(connection.pageInfo);
    if (info.hasNextPage === false) return { ...result, variants };
    if (info.hasNextPage !== true || typeof info.endCursor !== "string" || !info.endCursor || cursors.has(info.endCursor)) {
      throw new ImportError("Incomplete Shopify listing variant pagination.");
    }
    after = info.endCursor;
    cursors.add(after);
  }
  throw new ImportError("Shopify listing exceeds the review limit.");
}

export function supplierVariantIds(input: Payload): string[] {
  const ids = input.variants.map((variant) => variant.metafields.find((field) =>
    field.namespace === "ultralove_catalog" && field.key === "supplier_id")?.value);
  if (ids.some((id) => !id || !/^[1-9]\d*$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new ImportError("Supplier variants have missing or duplicate identities. Review required.");
  }
  return ids as string[];
}
export function matchListingVariants(snapshot: ListingSnapshot, input: Payload, explicitLink: boolean): string[] {
  const ids = supplierVariantIds(input);
  if (snapshot.variants.length !== ids.length) throw new ImportError("Supplier and Shopify variant sets differ. Reconnect to a listing with an exact complete variant match.");
  const metadata = snapshot.variants.map((variant) => variant.supplierId?.value);
  if (metadata.every((id) => id && ids.includes(id)) && new Set(metadata).size === ids.length) {
    return ids.map((id) => snapshot.variants.find((variant) => variant.supplierId?.value === id)!.id);
  }
  if (!explicitLink) {
    throw new ImportError("Variant supplier identities are missing, conflicting or ambiguous. Explicitly reconnect a compatible listing.");
  }
  const skus = input.variants.map((variant) => variant.sku);
  const actual = snapshot.variants.map((variant) => variant.sku);
  if (skus.some((sku) => !sku.trim()) || actual.some((sku) => !sku?.trim()) ||
      new Set(skus).size !== skus.length || new Set(actual).size !== actual.length || actual.some((sku) => !skus.includes(sku!))) {
    throw new ImportError("Link requires an exact complete set of nonempty unique SKUs or supplier variant metadata. No variant guessing is allowed.");
  }
  return skus.map((sku, index) => {
    const variant = snapshot.variants.find((variant) => variant.sku === sku)!;
    if (variant.supplierId && variant.supplierId.value !== ids[index]) {
      throw new ImportError("Variant supplier identities conflict with the exact SKU match. No variant guessing is allowed.");
    }
    return variant.id;
  });
}
export function assertLinkOwnership(snapshot: ListingSnapshot, supplierId: number, knownProductId?: string | null) {
  const canonical = /^ultralove-catalog-([1-9]\d*)$/.exec(snapshot.handle);
  if ((canonical && canonical[1] !== String(supplierId)) ||
      (snapshot.supplierId && snapshot.supplierId.value !== String(supplierId)) ||
      (!snapshot.supplierId && knownProductId !== snapshot.id && snapshot.tags.some((tag) => tag.startsWith("ultralove-catalog-")))) {
    throw new ImportError("Supplier identity collision on link target; no listing was changed.");
  }
}
function imageMarker(source: string) {
  return `UltraLove supplier image ${createHash("sha256").update(source).digest("hex")}`;
}
function supplierImages(input: Payload) {
  if (input.files === undefined) return [];
  if (!Array.isArray(input.files)) throw new ImportError("Invalid supplier image list.");
  const unique = new Map<string, { originalSource: string; alt: string; mediaContentType: "IMAGE" }>();
  for (const value of input.files) {
    const file = object(value);
    if (typeof file.originalSource !== "string" || !/^https:\/\//.test(file.originalSource)) {
      throw new ImportError("Supplier image requires an HTTPS source.");
    }
    unique.set(file.originalSource, { originalSource: file.originalSource, alt: imageMarker(file.originalSource), mediaContentType: "IMAGE" });
  }
  return [...unique.values()];
}
function missingImages(snapshot: ListingSnapshot, input: Payload) {
  return supplierImages(input).filter((file) => !snapshot.media.some((image) =>
    image.alt === file.alt || image.image?.url === file.originalSource));
}
function content(input: Payload) {
  return Object.fromEntries(["title", "descriptionHtml", "vendor"].filter((key) => typeof input[key] === "string")
    .map((key) => [key, input[key] as string]));
}
function canonicalDescription(value: string) {
  const fragment = parseFragment(value);
  const normalize = (node: DefaultTreeAdapterTypes.Node, preserveWhitespace = false) => {
    if ("attrs" in node) node.attrs.sort((a, b) => a.name.localeCompare(b.name));
    const tag = "tagName" in node ? node.tagName : "";
    const preserve = preserveWhitespace || ["pre", "textarea", "script", "style"].includes(tag) ||
      ("attrs" in node && node.attrs.some((attribute) => attribute.name === "style" &&
        /white-space\s*:\s*(?:pre|break-spaces)/i.test(attribute.value)));
    if ("childNodes" in node) {
      if (!preserve && "attrs" in node && !node.attrs.length &&
          ["ul", "ol", "dl", "table", "thead", "tbody", "tfoot", "tr", "colgroup"].includes(tag)) {
        node.childNodes = node.childNodes.filter((child) => !("value" in child) || !/^[\t\n\f\r ]*$/.test(child.value));
      }
      node.childNodes.forEach((child) => normalize(child, preserve));
    }
  };
  normalize(fragment);
  return serialize(fragment);
}
function contentMatches(field: string, before: string, after: string) {
  return before === after || (field === "descriptionHtml" && canonicalDescription(before) === canonicalDescription(after));
}
export function listingChanges(snapshot: ListingSnapshot, input: Payload, policy: ListingPolicy, variantIds: string[]) {
  const changes: ListingReview["changes"] = [];
  if (policy.mode !== "UPDATE") return changes;
  if (policy.content) for (const [field, after] of Object.entries(content(input))) {
    const before = snapshot[field as "title" | "descriptionHtml" | "vendor"];
    const label = field === "title" ? "Product name" : field === "descriptionHtml" ? "Description" : "Vendor";
    if (!contentMatches(field, before, after)) changes.push({ field: label, before, after });
  }
  if (policy.prices) input.variants.forEach((variant, index) => {
    const existing = snapshot.variants.find((value) => value.id === variantIds[index])!;
    const label = existing.sku || existing.selectedOptions.map((option) => `${option.name}: ${option.value}`).join(", ");
    if (cadCents(existing.price) !== cadCents(variant.price)) {
      changes.push({ field: `Retail price${label ? ` (${label})` : ""}`, before: existing.price, after: variant.price });
    }
  });
  if (policy.images) for (const image of missingImages(snapshot, input)) {
    changes.push({ field: "Add supplier image", before: "", after: image.originalSource });
  }
  return changes;
}

// On retry, only an operation durably recorded before its request can explain a partial change.
function assertBaseline(current: ListingSnapshot, baseline: ListingSnapshot, input: Payload, policy: ListingPolicy,
  supplierId: number, runId: string, work: ListingWork) {
  const started = work.started || [];
  const expected = structuredClone(baseline);
  const actual = structuredClone(current);
  if (!started.length && current.updatedAt !== baseline.updatedAt) throw new ImportError("Shopify listing changed since preview. Review a fresh snapshot.");
  actual.updatedAt = expected.updatedAt;
  if (started.includes("content") && policy.content) for (const [key, after] of Object.entries(content(input))) {
    if (!contentMatches(key, actual[key as "title"], expected[key as "title"]) &&
        !contentMatches(key, actual[key as "title"], after)) {
      throw new ImportError("Reviewed Shopify content changed concurrently. Create a fresh preview.");
    }
    actual[key as "title"] = expected[key as "title"];
  }
  if (policy.prices) input.variants.forEach((variant, index) => {
    if (!started.includes(`prices:${Math.floor(index / 250) * 250}`)) return;
    const id = work.variantIds![index];
    const before = expected.variants.find((value) => value.id === id);
    const now = actual.variants.find((value) => value.id === id);
    if (!before || !now || (cadCents(now.price) !== cadCents(before.price) && cadCents(now.price) !== cadCents(variant.price))) {
      throw new ImportError("Reviewed Shopify variant price or identity changed concurrently.");
    }
    now.price = before.price;
  });
  const sources = supplierVariantIds(input);
  const normalizeMetadata = (now: SupplierField, before: SupplierField, owner: string, source: string) => {
    if (JSON.stringify(now) === JSON.stringify(before)) return before;
    if (started.includes(`identity:${owner}`) && now?.value === source && (!before || before.value === source)) return before;
    throw new ImportError("Supplier ownership changed concurrently. No further mutation was applied.");
  };
  actual.supplierId = normalizeMetadata(actual.supplierId, expected.supplierId, current.id, String(supplierId));
  for (const variant of actual.variants) {
    const before = expected.variants.find((value) => value.id === variant.id);
    if (!before) throw new ImportError("Shopify variant identities changed since review.");
    const index = work.variantIds!.indexOf(variant.id);
    variant.supplierId = normalizeMetadata(variant.supplierId, before.supplierId, variant.id, sources[index]);
  }
  if (started.includes("tags")) {
    const added = ["ultralove-catalog-import", "ultralove-catalog-linked", `ultralove-catalog-run-${runId}`];
    actual.tags = actual.tags.filter((tag) => expected.tags.includes(tag) || !added.includes(tag));
  }
  actual.tags.sort(); expected.tags.sort();
  if (started.includes("images")) {
    const additions = new Set(supplierImages(input).map((image) => image.alt));
    actual.media = actual.media.filter((image) => expected.media.some((before) => before.id === image.id) || !additions.has(image.alt || ""));
  }
  // Supplier image processing is asynchronous; original retailer media identities/URLs/alt must remain intact.
  for (const image of actual.media) {
    const before = expected.media.find((value) => value.id === image.id);
    if (before) image.status = before.status;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new ImportError("Shopify listing baseline changed since review. Re-preview before continuing.");
}
async function mutation(api: GraphQL, query: string, variables: Record<string, unknown>, key: string) {
  const response = object((await request(api, query, variables))[key]);
  if (!Array.isArray(response.userErrors) || response.userErrors.length) {
    throw new ImportError(`Shopify listing mutation requires review: ${JSON.stringify(response.userErrors)}`);
  }
}
export async function applyListing(options: {
  api: GraphQL; input: Payload; policy: ListingPolicy; review: ListingReview; work: ListingWork;
  supplierId: number; runId: string; saveWork: (work: ListingWork) => Promise<void>;
  beforeOperation?: () => Promise<void>;
}): Promise<{ status: "UPDATED" | "LINKED"; productId: string }> {
  const { api, input, policy, review, supplierId, runId, saveWork } = options;
  const work = structuredClone(options.work);
  if (!work.baseline || !work.variantIds || !review.targetId || !work.capturedAt ||
      Date.now() - work.capturedAt > MAX_PREVIEW_AGE) throw new ImportError("Listing snapshot expired or invalid. Review a fresh preview before further changes.");
  const refresh = async () => {
    if (Date.now() - work.capturedAt! > MAX_PREVIEW_AGE) throw new ImportError("Listing snapshot expired. Re-preview before further mutations.");
    await options.beforeOperation?.();
    const snapshot = await listingSnapshot(api, review.targetId!);
    if (!snapshot) throw new ImportError("The Shopify product disappeared after this review. Create a fresh preview to verify a replacement, or reconnect an existing product.");
    assertLinkOwnership(snapshot, supplierId, work.expectedProductId);
    assertBaseline(snapshot, work.baseline!, input, policy, supplierId, runId, work);
    if (policy.mode === "UPDATE" && policy.images && snapshot.media.some((image) =>
      supplierImages(input).some((file) => file.alt === image.alt) && image.status === "FAILED")) {
      throw new ImportError("Supplier image processing failed. Review Shopify media; no duplicate upload will be attempted.");
    }
    return snapshot;
  };
  const start = async (phase: string) => {
    work.started ||= [];
    if (!work.started.includes(phase)) {
      work.started.push(phase);
      await saveWork(work);
    }
  };
  let current = await refresh();
  if (review.action === "LINK") {
    const ids = supplierVariantIds(input);
    const owners = [{ id: current.id, source: String(supplierId), field: current.supplierId },
      ...work.variantIds.map((id, index) => ({ id, source: ids[index], field: current.variants.find((variant) => variant.id === id)!.supplierId }))];
    for (const owner of owners) {
      if (owner.field?.value === owner.source) continue;
      await refresh();
      await start(`identity:${owner.id}`);
      await mutation(api, LISTING_METADATA_MUTATION, { metafields: [{
        ownerId: owner.id, namespace: "ultralove_catalog", key: "supplier_id", type: "single_line_text_field",
        value: owner.source, compareDigest: null,
      }] }, "metafieldsSet");
    }
    current = await refresh();
    const tags = ["ultralove-catalog-import", "ultralove-catalog-linked", `ultralove-catalog-run-${runId}`].filter((tag) => !current.tags.includes(tag));
    if (tags.length) {
      await start("tags");
      await mutation(api, LISTING_TAGS_MUTATION, { id: current.id, tags }, "tagsAdd");
    }
  } else if (!ownedProduct(current, supplierId)) {
    throw new ImportError("Supplier ownership no longer matches the reviewed listing.");
  }
  current = await refresh();
  if (policy.mode === "UPDATE" && policy.content &&
      Object.entries(content(input)).some(([key, value]) => !contentMatches(key, current[key as "title"], value))) {
    await start("content");
    await mutation(api, LISTING_UPDATE_MUTATION, { product: { id: current.id, ...content(input) } }, "productUpdate");
  }
  if (policy.mode === "UPDATE" && policy.prices) {
    for (let offset = 0; offset < input.variants.length; offset += 250) {
      current = await refresh();
      const variants = input.variants.slice(offset, offset + 250).flatMap((variant, index) => {
        const id = work.variantIds![offset + index];
        return cadCents(current.variants.find((value) => value.id === id)!.price) === cadCents(variant.price) ? [] : [{ id, price: variant.price }];
      });
      if (variants.length) {
        await start(`prices:${offset}`);
        await mutation(api, LISTING_PRICES_MUTATION, { id: current.id, variants }, "productVariantsBulkUpdate");
      }
    }
  }
  current = await refresh();
  if (policy.mode === "UPDATE" && policy.images) {
    const missing = missingImages(current, input);
    if (missing.length && work.started?.includes("images")) {
      throw new ImportError("An image request may have reached Shopify. Review processing/failed media; uncertain images will not be duplicated.");
    }
    if (missing.length) {
      await start("images");
      await mutation(api, LISTING_UPDATE_MUTATION, { product: { id: current.id }, media: missing }, "productUpdate");
    }
  }
  current = await refresh();
  const remaining = listingChanges(current, input, policy, work.variantIds);
  if (!ownedProduct(current, supplierId) || matchListingVariants(current, input, false).join() !== work.variantIds.join() ||
      remaining.length) {
    throw new ImportError(remaining.length
      ? `Shopify did not confirm reviewed fields: ${[...new Set(remaining.map((change) => change.field))].join(", ")}. Retry reconciliation; completed operations remain protected.`
      : "Shopify did not confirm all reviewed changes. Retry reconciliation; completed operations remain protected.");
  }
  return { status: review.action === "LINK" ? "LINKED" : "UPDATED", productId: current.id };
}
