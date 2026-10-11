import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVATE_MUTATION, CREATE_MUTATION, PUBLICATIONS_QUERY, PUBLICATION_STATE_QUERY, PUBLISH_MUTATION, VERIFY_QUERY,
  importChoices, importConfirmation, importDraft, importSettings, onlineStorePublication,
  IMAGE_READY_ATTEMPTS, IMAGE_READY_INTERVAL_MS,
} from "../app/import-engine.ts";

const run = "a".repeat(32);
const publicationId = "gid://shopify/Publication/10";
const input = {
  title: "Sample product", handle: "ultralove-catalog-100", status: "DRAFT",
  tags: ["ultralove-catalog-import", `ultralove-catalog-run-${run}`],
  metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", value: "100" }],
  variants: [{
    sku: "SKU-100", price: "12.50", inventoryPolicy: "DENY", inventoryItem: { tracked: true },
    inventoryQuantities: [{ locationId: "gid://shopify/Location/1", name: "available", quantity: 0 }],
    metafields: [{ namespace: "ultralove_catalog", key: "supplier_id", value: "100" }],
  }],
};
const product = {
  id: "gid://shopify/Product/1", handle: input.handle, status: "DRAFT", tags: input.tags,
  supplierId: { value: "100" }, variants: { nodes: [{ sku: "SKU-100", price: "12.50" }] },
};
const base = {
  products: [], input, supplierId: 100, runId: run, attempted: false, previouslyMapped: false,
  fresh: true, beforeMutation: async () => {},
};
function verification(status = "DRAFT") {
  return { data: { product: { status, variants: {
    nodes: [{ sku: "SKU-100", price: "12.50", barcode: null, inventoryPolicy: "DENY", supplierId: { value: "100" },
      inventoryItem: { tracked: true, inventoryLevel: { quantities: [{ name: "available", quantity: 0 }] } } }],
    pageInfo: { hasNextPage: false },
  } } } };
}
function state(status, published, images = []) {
  return { data: { product: { id: product.id, status, publishedOnPublication: published,
    media: { nodes: images, pageInfo: { hasNextPage: false } } } } };
}
const created = () => ({ data: { productSet: { product: structuredClone(product), userErrors: [] } } });
const activated = () => ({ data: { productUpdate: { product: { id: product.id, status: "ACTIVE" }, userErrors: [] } } });
const published = () => ({ data: { publishablePublish: { userErrors: [] } } });

test("visibility switches default off, reject forged values, and require Active for publishing", () => {
  assert.deepEqual(importChoices(new FormData()), { active: false, publish: false });
  const form = new FormData();
  form.set("active", "yes");
  assert.deepEqual(importChoices(form), { active: true, publish: false });
  form.set("publish", "yes");
  assert.deepEqual(importChoices(form), { active: true, publish: true });
  form.delete("active");
  assert.throws(() => importChoices(form), /requires Active/);
  form.set("active", "yes");
  form.append("active", "yes");
  assert.throws(() => importChoices(form), /Invalid active/);
  form.set("active", "yes");
  form.set("publish", "true");
  assert.throws(() => importChoices(form), /Invalid publish/);
  assert.equal(importConfirmation(importSettings(false, null)), "draft-only");
  assert.equal(importConfirmation(importSettings(true, null)), "active-only");
  assert.equal(importConfirmation(importSettings(true, publicationId)), "publish-online-store");
  for (const values of [[false, publicationId], ["true", null], [true, ""], [true, "gid://shopify/Publication/0"], [true, product.id]]) {
    assert.throws(() => importSettings(...values), /Invalid saved/);
  }
});

test("Online Store discovery checks permissions and never substitutes another sales channel", async () => {
  const response = { data: {
    currentAppInstallation: { accessScopes: [{ handle: "read_publications" }, { handle: "write_publications" }] },
    publications: { nodes: [
      { id: "gid://shopify/Publication/20", catalog: {
        title: "Channel Catalog 20 for Point of Sale",
        apps: { nodes: [{ title: "Point of Sale" }], pageInfo: { hasNextPage: false } },
      } },
      { id: publicationId, catalog: {
        title: "Channel Catalog 10 for Online Store",
        apps: { nodes: [{ title: "Online Store" }], pageInfo: { hasNextPage: false } },
      } },
    ], pageInfo: { hasNextPage: false } },
  } };
  assert.equal(await onlineStorePublication(async (query) => { assert.equal(query, PUBLICATIONS_QUERY); return response; }), publicationId);
  assert.equal(await onlineStorePublication(async () => ({ data: { ...response.data,
    currentAppInstallation: { accessScopes: [{ handle: "write_publications" }] },
  } })), publicationId, "a successful query and its write scope also cover implied read access");
  await assert.rejects(onlineStorePublication(async () => ({ errors: [{ message: "Access denied" }] })), /permissions/);
  await assert.rejects(onlineStorePublication(async () => ({ data: { ...response.data, currentAppInstallation: { accessScopes: [] } } })), /Authorize both/);
  for (const publications of [
    { ...response.data.publications, pageInfo: { hasNextPage: true } },
    { ...response.data.publications, nodes: [response.data.publications.nodes[0]] },
    { ...response.data.publications, nodes: Array(2).fill(response.data.publications.nodes[1]) },
    { ...response.data.publications, nodes: [{ id: publicationId, catalog: null }] },
    { ...response.data.publications, nodes: [{ id: publicationId,
      catalog: { apps: { nodes: [{ title: "Online Store" }], pageInfo: { hasNextPage: true } } },
    }] },
  ]) await assert.rejects(onlineStorePublication(async () => ({ data: { ...response.data, publications } })));
});

test("Active-only imports create and verify a draft before activation and never request publication", async () => {
  const calls = [];
  const products = [];
  const result = await importDraft({ ...base, products, active: true, beforeMutation: async () => calls.push("claim"),
    api: async (query, variables) => {
      if (query === CREATE_MUTATION) {
        assert.equal(variables.input.status, "DRAFT");
        calls.push("create");
        return created();
      }
      if (query === VERIFY_QUERY) { calls.push("verify"); return verification(); }
      assert.equal(query, ACTIVATE_MUTATION);
      assert.deepEqual(variables.product, { id: product.id, status: "ACTIVE" });
      calls.push("activate");
      return activated();
    },
  });
  assert.deepEqual(calls, ["claim", "create", "verify", "activate"]);
  assert.deepEqual(result, { status: "CREATED", productId: product.id });
  assert.equal(products[0].status, "ACTIVE");
});

test("publishing activates only the new owned product and verifies the approved Online Store publication", async () => {
  const calls = [];
  let reads = 0;
  const withImage = { ...input, files: [{ originalSource: "https://example.com/image.jpg", contentType: "IMAGE" }] };
  const result = await importDraft({ ...base, input: withImage, products: [], active: true, publicationId,
    api: async (query, variables) => {
      calls.push(query);
      if (query === CREATE_MUTATION) return created();
      if (query === VERIFY_QUERY) return verification();
      if (query === PUBLICATION_STATE_QUERY) {
        assert.deepEqual(variables, { id: product.id, publicationId });
        return ++reads === 1 ? state("DRAFT", false, [{ status: "READY" }]) : state("ACTIVE", true, [{ status: "READY" }]);
      }
      if (query === ACTIVATE_MUTATION) return activated();
      assert.equal(query, PUBLISH_MUTATION);
      assert.deepEqual(variables, { id: product.id, input: [{ publicationId }] });
      return published();
    },
  });
  assert.equal(result.status, "CREATED");
  assert.deepEqual(calls, [CREATE_MUTATION, VERIFY_QUERY, PUBLICATION_STATE_QUERY, ACTIVATE_MUTATION, PUBLISH_MUTATION, PUBLICATION_STATE_QUERY]);
});

test("processing, missing, failed or truncated media blocks publication with bounded waits and distinct failures", async (context) => {
  let waits = 0;
  context.mock.method(globalThis, "setTimeout", (resolve, duration) => { assert.equal(duration, IMAGE_READY_INTERVAL_MS); waits++; resolve(); });
  try {
    const withImage = { ...input, files: [{ originalSource: "https://example.com/image.jpg", contentType: "IMAGE" }] };
    for (const [media, message, expectedWaits] of [
      [{ nodes: [], pageInfo: { hasNextPage: false } }, /still missing/, IMAGE_READY_ATTEMPTS - 1],
      [{ nodes: [{ status: "PROCESSING" }], pageInfo: { hasNextPage: false } }, /still processing/, IMAGE_READY_ATTEMPTS - 1],
      [{ nodes: [{ status: "UPLOADED" }], pageInfo: { hasNextPage: false } }, /still processing/, IMAGE_READY_ATTEMPTS - 1],
      [{ nodes: [{ status: "FAILED" }], pageInfo: { hasNextPage: false } }, /failed processing/, 0],
      [{ nodes: [{ status: "READY" }], pageInfo: { hasNextPage: true } }, /do not match/, 0],
      [{ nodes: [{ status: "UNKNOWN" }], pageInfo: { hasNextPage: false } }, /unexpected processing status/, 0],
      [{ nodes: [{ status: "READY" }, { status: "READY" }], pageInfo: { hasNextPage: false } }, /do not match/, 0],
    ]) {
      waits = 0;
      let reads = 0;
      let creations = 0;
      let savedProductId;
      await assert.rejects(importDraft({ ...base, input: withImage, products: [], active: true, publicationId,
        onCreated: async (id) => { savedProductId = id; },
        api: async (query) => {
          if (query === CREATE_MUTATION) { creations++; return created(); }
          if (query === VERIFY_QUERY) return verification();
          assert.equal(query, PUBLICATION_STATE_QUERY, "no activation/publication is allowed");
          assert.equal(savedProductId, product.id, "the new listing is recorded before waiting");
          reads++;
          const response = state("DRAFT", false);
          response.data.product.media = media;
          return response;
        },
      }), message);
      assert.equal(waits, expectedWaits);
      assert.equal(reads, expectedWaits + 1);
      assert.equal(creations, 1, "image readiness never repeats creation");
    }
  } finally {
    context.mock.restoreAll();
  }
});

test("new and reconciled products wait for uploaded/processing images, reverify, then publish once", async (context) => {
  const waits = [];
  context.mock.method(globalThis, "setTimeout", (resolve, duration) => { waits.push(duration); resolve(); });
  try {
    for (const reconcile of [false, true]) {
      let reads = 0;
      let creates = 0;
      let verifies = 0;
      let activates = 0;
      let publishes = 0;
      const result = await importDraft({ ...base,
        input: { ...input, files: [{ originalSource: "https://example.com/image.jpg", contentType: "IMAGE" }] },
        products: reconcile ? [structuredClone(product)] : [], attempted: reconcile, fresh: !reconcile,
        active: true, publicationId, api: async (query) => {
          if (query === CREATE_MUTATION) { creates++; return created(); }
          if (query === VERIFY_QUERY) { verifies++; return verification(); }
          if (query === PUBLICATION_STATE_QUERY) {
            reads++;
            if (reads === 1) return state("DRAFT", false);
            if (reads === 2) return state("DRAFT", false, [{ status: "UPLOADED" }]);
            if (reads === 3) return state("DRAFT", false, [{ status: "PROCESSING" }]);
            return state(reads === 4 ? "DRAFT" : "ACTIVE", reads > 4, [{ status: "READY" }]);
          }
          assert.equal(reads, 4, "no mutation is allowed while images are missing or processing");
          if (query === ACTIVATE_MUTATION) { activates++; return activated(); }
          assert.equal(query, PUBLISH_MUTATION);
          publishes++;
          return published();
        },
      });
      assert.equal(result.status, "CREATED");
      assert.equal(creates, reconcile ? 0 : 1);
      assert.equal(verifies, 2);
      assert.equal(activates, 1);
      assert.equal(publishes, 1);
    }
    assert.deepEqual(waits, Array(6).fill(IMAGE_READY_INTERVAL_MS));
  } finally {
    context.mock.restoreAll();
  }
});

test("waiting never hides changed publication state, variant edits or API failures", async (context) => {
  context.mock.method(globalThis, "setTimeout", (resolve) => { resolve(); });
  try {
    for (const failure of ["status", "price", "api", "media", "published"]) {
      let reads = 0;
      let verifies = 0;
      await assert.rejects(importDraft({ ...base,
        input: { ...input, files: [{ originalSource: "https://example.com/image.jpg", contentType: "IMAGE" }] },
        products: [], active: true, publicationId, api: async (query) => {
          if (query === CREATE_MUTATION) return created();
          if (query === VERIFY_QUERY) {
            const response = verification();
            if (++verifies === 2) response.data.product.variants.nodes[0].price = "99.99";
            return response;
          }
          assert.equal(query, PUBLICATION_STATE_QUERY, "changed state cannot lead to activation or publication");
          if (++reads === 1) return state("DRAFT", false, [{ status: "PROCESSING" }]);
          if (failure === "api") throw new Error("API unavailable");
          return state(failure === "status" ? "ARCHIVED" : "DRAFT", failure === "published", [{ status: failure === "media" ? "FAILED" : "READY" }]);
        },
      }), failure === "status" ? /state changed/ : ["price", "published"].includes(failure) ? /verification/ : failure === "media" ? /failed processing/ : /API unavailable/);
    }
  } finally {
    context.mock.restoreAll();
  }
});
test("activation and publication user errors are explicit; unconfirmed publication is not success", async () => {
  await assert.rejects(importDraft({ ...base, products: [], active: true, api: async (query) => {
    if (query === CREATE_MUTATION) return created();
    if (query === VERIFY_QUERY) return verification();
    return { data: { productUpdate: { userErrors: [{ message: "Not allowed" }] } } };
  } }), /activation requires review: Not allowed/);
  for (const errors of [[{ message: "Channel unavailable" }], []]) {
    await assert.rejects(importDraft({ ...base, products: [], active: true, publicationId, api: async (query) => {
      if (query === CREATE_MUTATION) return created();
      if (query === VERIFY_QUERY) return verification();
      if (query === ACTIVATE_MUTATION) return activated();
      if (query === PUBLICATION_STATE_QUERY) return state("DRAFT", false);
      return { data: { publishablePublish: { userErrors: errors } } };
    } }), errors.length ? /Channel unavailable/ : /did not confirm/);
  }
});

test("an uncertain activation reconciles the own-run Active product without creating or activating again", async () => {
  await assert.rejects(importDraft({ ...base, products: [], active: true, api: async (query) => {
    if (query === CREATE_MUTATION) return created();
    if (query === VERIFY_QUERY) return verification();
    throw new Error("Connection lost after activation");
  } }), /Connection lost/);
  const result = await importDraft({ ...base, products: [{ ...product, status: "ACTIVE" }], attempted: true, active: true, fresh: false,
    api: async (query) => { assert.equal(query, VERIFY_QUERY); return verification("ACTIVE"); },
  });
  assert.equal(result.status, "CREATED");
});

test("publication retries reconcile success read-only, or finish publishing without another creation/activation", async () => {
  for (const alreadyPublished of [true, false]) {
    let reads = 0;
    let publishes = 0;
    const result = await importDraft({ ...base, products: [{ ...product, status: "ACTIVE" }], attempted: true,
      active: true, publicationId, fresh: false, api: async (query) => {
        if (query === VERIFY_QUERY) return verification("ACTIVE");
        if (query === PUBLICATION_STATE_QUERY) return state("ACTIVE", ++reads > 1 || alreadyPublished);
        assert.equal(query, PUBLISH_MUTATION, "creation and activation must not repeat");
        publishes++;
        return published();
      },
    });
    assert.equal(result.status, "CREATED");
    assert.equal(publishes, alreadyPublished ? 0 : 1);
  }
});

test("prior-run products stay unchanged even when Active and publishing are requested", async () => {
  for (const status of ["DRAFT", "ACTIVE", "ARCHIVED"]) {
    const existing = { ...product, status, tags: ["ultralove-catalog-import", `ultralove-catalog-run-${"b".repeat(32)}`] };
    const baseline = structuredClone(existing);
    const result = await importDraft({ ...base, products: [existing], active: true, publicationId,
      api: async () => { throw new Error("Existing products must not be mutated"); },
    });
    assert.equal(result.status, "REUSED");
    assert.deepEqual(existing, baseline);
  }
});

test("unexpected status and changed variant data cannot be activated or published", async () => {
  for (const changed of [verification("ARCHIVED"), verification("DRAFT")]) {
    if (changed.data.product.status === "DRAFT") changed.data.product.variants.nodes[0].price = "99.99";
    await assert.rejects(importDraft({ ...base, products: [product], active: true, publicationId,
      api: async (query) => { assert.equal(query, VERIFY_QUERY); return changed; },
    }), /verification|status/);
  }
});
