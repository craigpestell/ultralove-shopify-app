import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";

test("persistent queue enforces one active shop job, immutable selections and preview expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ultralove-job-test-"));
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${join(directory, "test.sqlite")}`;
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom" });
  const { default: db } = await server.ssrLoadModule("/app/db.server.ts");
  try {
    for (const migration of ["20261009120000_catalog_selection", "20261009130000_import_jobs"]) {
      const sql = await readFile(new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8");
      for (const statement of sql.split(";").filter((part) => part.trim())) await db.$executeRawUnsafe(statement);
    }
    const legacy = "e".repeat(32);
    await db.$executeRawUnsafe(`INSERT INTO "ImportJob" ("id","shop","selection","markup","locationId","generation","cursor","updatedAt")
      VALUES (?,?,?,?,?,?,?,?)`, legacy, "ultralove-integration-lab.myshopify.com", "[100]", "0.00", "gid://shopify/Location/1", "a".repeat(36), 1, new Date());
    const visibility = await readFile(new URL("../prisma/migrations/20261009190000_import_visibility/migration.sql", import.meta.url), "utf8");
    for (const statement of visibility.split(";").filter((part) => part.trim())) await db.$executeRawUnsafe(statement);
    const migrated = await db.importJob.findUnique({ where: { id: legacy } });
    assert.equal(migrated.active, false, "old jobs remain draft-only");
    assert.equal(migrated.publicationId, null);
    const shop = "ultralove-integration-lab.myshopify.com";
    await db.catalogSelection.create({ data: { shop, productIds: "[100]" } });
    const { queueJob, importScreen } = await server.ssrLoadModule("/app/imports.server.ts");
    const seed = async (id, changes = {}) => db.importJob.create({ data: {
      id, shop, selection: "[100]", markup: "25.00", locationId: "gid://shopify/Location/1",
      generation: "a".repeat(36), cursor: 1, ...changes,
    } });
    const first = "a".repeat(32);
    const second = "b".repeat(32);
    await seed(first);
    await seed(second);
    await queueJob(shop, first, false);
    assert.equal((await db.importJob.findUnique({ where: { id: first } })).status, "QUEUED");
    await assert.rejects(queueJob(shop, first, false), /current state/);
    await assert.rejects(queueJob(shop, second, false), /Another import job/);
    await db.importJob.update({ where: { id: first }, data: { status: "FAILED", activeShop: null } });
    await queueJob(shop, first, true);
    await db.importJob.update({ where: { id: first }, data: { status: "COMPLETE", activeShop: null } });
    const old = "c".repeat(32);
    await seed(old, { createdAt: new Date(Date.now() - 11 * 60 * 1000) });
    await assert.rejects(queueJob(shop, old, false), /expired/);
    await db.catalogSelection.update({ where: { shop }, data: { productIds: "[101]" } });
    await assert.rejects(queueJob(shop, second, false), /selections changed/);
    assert.equal((await db.importJob.findUnique({ where: { id: second } })).status, "PREVIEW");
    await db.catalogSelection.update({ where: { shop }, data: { productIds: "[100]" } });
    const active = "d".repeat(32);
    await seed(active, { active: true });
    await assert.rejects(queueJob(shop, active, false, "draft-only"), /saved import visibility/);
    await queueJob(shop, active, false, "active-only");
    const activeScreen = await importScreen(shop, active);
    assert.equal(activeScreen.job.active, true);
    assert.equal(activeScreen.job.publicationId, null);
    assert.equal(activeScreen.job.confirmation, "active-only");
    await db.importJob.update({ where: { id: active }, data: { status: "COMPLETE", activeShop: null } });
    const published = "f".repeat(32);
    const publicationId = "gid://shopify/Publication/10";
    await seed(published, { active: true, publicationId });
    await assert.rejects(queueJob(shop, published, false, "active-only"), /saved import visibility/);
    await queueJob(shop, published, false, "publish-online-store");
    await db.importJob.update({ where: { id: published }, data: { status: "FAILED", activeShop: null } });
    await assert.rejects(queueJob(shop, published, true, "draft-only"), /saved import visibility/);
    await queueJob(shop, published, true, "publish-online-store");
    const publishedScreen = await importScreen(shop, published);
    assert.equal(publishedScreen.job.active, true);
    assert.equal(publishedScreen.job.publicationId, publicationId);
    assert.equal(publishedScreen.job.confirmation, "publish-online-store");
  } finally {
    await db.$disconnect();
    await server.close();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await rm(directory, { recursive: true });
  }
});
