import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import {
  ACTIVATE_MUTATION, CATALOG_QUERY, CONTEXT_QUERY, CREATE_MUTATION,
  PUBLICATIONS_QUERY, PUBLICATION_STATE_QUERY, PUBLISH_MUTATION, VERIFY_QUERY,
} from "../app/import-engine.ts";

test("published jobs persist opt-in settings and recover an uncertain publication without duplicate mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ultralove-import-flow-"));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${join(directory, "test.sqlite")}`;
  const server = await createServer({
    configFile: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom",
    plugins: [{
      name: "test-supplier-transport",
      enforce: "pre",
      load(id) {
        if (!id.endsWith("/app/catalog.server.ts")) return;
        return `
          export async function validateSelection() {}
          export async function importPlan(ids, location, run) {
            return { generation: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", cursor: 1,
              items: ids.map(id => ({supplierId:id, name:"Sample product", sku:"SKU-"+id, wholesale:["12.50"],
                payload: {title:"Sample product", handle:"ultralove-catalog-"+id, status:"DRAFT",
                  tags:["ultralove-catalog-import","ultralove-catalog-run-"+run],
                  metafields:[{namespace:"ultralove_catalog",key:"supplier_id",value:String(id)}],
                  variants:[{sku:"SKU-"+id,price:"15.63",inventoryPolicy:"DENY",inventoryItem:{tracked:true},
                    inventoryQuantities:[{locationId:location,name:"available",quantity:0}],
                    metafields:[{namespace:"ultralove_catalog",key:"supplier_id",value:String(id)}]}]
                }
              })) };
          }`;
      },
    }],
  });
  const { default: db } = await server.ssrLoadModule("/app/db.server.ts");
  try {
    for (const migration of ["20261009120000_catalog_selection", "20261009130000_import_jobs", "20261009190000_import_visibility"]) {
      const sql = await readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8");
      for (const statement of sql.split(";").filter((part) => part.trim())) await db.$executeRawUnsafe(statement);
    }
    const { createPreview, importScreen, queueJob, runJob } = await server.ssrLoadModule("/app/imports.server.ts");
    const shop = "ultralove-integration-lab.myshopify.com";
    const location = "gid://shopify/Location/1";
    let publicationId = "gid://shopify/Publication/10";
    let remote = null;
    let isPublished = false;
    let sentInput;
    const mutations = { create: 0, activate: 0, publish: 0 };
    const api = async (query, variables) => {
      if (query === CONTEXT_QUERY) return { data: {
        shop: { myshopifyDomain: shop, currencyCode: "CAD" },
        locations: { nodes: [{ id: location, name: "Shop location", isActive: true, fulfillsOnlineOrders: true }], pageInfo: { hasNextPage: false } },
      } };
      if (query === PUBLICATIONS_QUERY) return { data: {
        currentAppInstallation: { accessScopes: [{ handle: "read_publications" }, { handle: "write_publications" }] },
        publications: { nodes: [{ id: publicationId, catalog: { title: "Online Store" } }], pageInfo: { hasNextPage: false } },
      } };
      if (query === CATALOG_QUERY) return { data: { products: { nodes: remote ? [remote] : [], pageInfo: { hasNextPage: false } } } };
      if (query === CREATE_MUTATION) {
        const claim = await db.importClaim.findUnique({ where: { shop_supplierId: { shop, supplierId: 100 } } });
        assert.ok(claim?.mutationStartedAt, "creation claim must precede the API mutation");
        assert.equal(variables.input.status, "DRAFT");
        sentInput = variables.input;
        mutations.create++;
        remote = {
          id: "gid://shopify/Product/1", handle: sentInput.handle, status: "DRAFT", tags: sentInput.tags,
          supplierId: { value: "100" }, variants: { nodes: [{ sku: "SKU-100", price: "15.63" }] },
        };
        return { data: { productSet: { product: structuredClone(remote), userErrors: [] } } };
      }
      if (query === VERIFY_QUERY) return { data: { product: { status: remote.status, variants: {
        nodes: [{ sku: "SKU-100", price: "15.63", barcode: null, inventoryPolicy: "DENY", supplierId: { value: "100" },
          inventoryItem: { tracked: true, inventoryLevel: { quantities: [{ name: "available", quantity: 0 }] } } }],
        pageInfo: { hasNextPage: false },
      } } } };
      if (query === PUBLICATION_STATE_QUERY) return { data: { product: {
        id: remote.id, status: remote.status, publishedOnPublication: isPublished,
        media: { nodes: [], pageInfo: { hasNextPage: false } },
      } } };
      if (query === ACTIVATE_MUTATION) {
        const item = await db.importItem.findFirst({ where: { supplierId: 100, status: "RUNNING" } });
        assert.equal(item.productId, remote.id, "record the Shopify link before activation/publication");
        mutations.activate++;
        remote.status = "ACTIVE";
        return { data: { productUpdate: { product: { id: remote.id, status: remote.status }, userErrors: [] } } };
      }
      assert.equal(query, PUBLISH_MUTATION);
      assert.deepEqual(variables.input, [{ publicationId }]);
      mutations.publish++;
      isPublished = true;
      throw new Error("Simulated connection loss after successful publication");
    };

    await db.catalogSelection.create({ data: { shop, productIds: "[100]" } });
    const preview = await createPreview(shop, "25", api, { active: true, publish: true });
    assert.equal(preview.active, true);
    assert.equal(preview.publicationId, publicationId);
    const screen = await importScreen(shop, preview.id);
    assert.equal(screen.job.confirmation, "publish-online-store");
    assert.equal(screen.job.items[0].retail, "15.63 CAD");
    await assert.rejects(queueJob(shop, preview.id, false, "draft-only"), /saved import visibility/);
    await queueJob(shop, preview.id, false, "publish-online-store");
    await runJob(preview.id, shop, api, () => false);
    const failed = await importScreen(shop, preview.id);
    assert.equal(failed.job.status, "FAILED");
    assert.equal(failed.job.items[0].status, "FAILED");
    assert.equal(failed.job.items[0].productId, remote.id, "failed publication still exposes the created product for review");
    assert.match(failed.job.items[0].error, /uncertain creations/);
    assert.deepEqual(mutations, { create: 1, activate: 1, publish: 1 });

    await queueJob(shop, preview.id, true, "publish-online-store");
    await runJob(preview.id, shop, api, () => false);
    const completed = await importScreen(shop, preview.id);
    assert.equal(completed.job.status, "COMPLETE");
    assert.equal(completed.job.items[0].status, "CREATED");
    assert.equal(completed.job.items[0].productId, remote.id);
    assert.deepEqual(mutations, { create: 1, activate: 1, publish: 1 }, "retry must be read-only when activation/publication succeeded");

    const existing = structuredClone(remote);
    const reuse = await createPreview(shop, "25", api, { active: true, publish: true });
    await queueJob(shop, reuse.id, false, "publish-online-store");
    await runJob(reuse.id, shop, api, () => false);
    assert.equal((await importScreen(shop, reuse.id)).job.items[0].status, "REUSED");
    assert.deepEqual(remote, existing);
    assert.deepEqual(mutations, { create: 1, activate: 1, publish: 1 });

    const stale = await createPreview(shop, "25", api, { active: true, publish: true });
    publicationId = "gid://shopify/Publication/11";
    await queueJob(shop, stale.id, false, "publish-online-store");
    await runJob(stale.id, shop, api, () => false);
    const blocked = await importScreen(shop, stale.id);
    assert.equal(blocked.job.status, "FAILED");
    assert.match(blocked.job.error, /publication changed/);
    assert.deepEqual(mutations, { create: 1, activate: 1, publish: 1 });
  } finally {
    await db.$disconnect();
    await server.close();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await rm(directory, { recursive: true });
  }
});
