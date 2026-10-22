import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";

test("settings read the live release, the last update check and the catalog connection safely", async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom" });
  const directory = await mkdtemp(join(tmpdir(), "ultralove-settings-"));
  try {
    const { currentRelease, updateStatus, catalogConnection, inventoryHealth } = await server.ssrLoadModule("/app/settings.server.ts");
    const { CatalogError } = await server.ssrLoadModule("/app/catalog.server.ts");
    const sha = "a".repeat(40);

    assert.equal(await currentRelease(join(directory, "missing")), null, "development has no release symlink");
    await mkdir(join(directory, "releases", sha), { recursive: true });
    await symlink(join(directory, "releases", sha), join(directory, "current"));
    const release = await currentRelease(join(directory, "current"));
    assert.equal(release.release, sha);
    assert.ok(!Number.isNaN(Date.parse(release.deployedAt)));
    await symlink(join(directory, "releases", "not-a-sha"), join(directory, "odd"));
    assert.equal(await currentRelease(join(directory, "odd")), null);

    const status = join(directory, "status.json");
    assert.equal(await updateStatus(status), null, "no check recorded yet");
    await writeFile(status, JSON.stringify({ checkedAt: "2026-10-22T07:00:00Z", result: "waiting", release: sha, checks: "in_progress" }));
    assert.deepEqual(await updateStatus(status), { checkedAt: "2026-10-22T07:00:00.000Z", result: "waiting", release: sha, checks: "in_progress" });
    await writeFile(status, JSON.stringify({ checkedAt: "2026-10-22T07:00:00Z", result: "off", release: "", checks: "" }));
    assert.deepEqual(await updateStatus(status), { checkedAt: "2026-10-22T07:00:00.000Z", result: "off", release: null, checks: null });
    await writeFile(status, JSON.stringify({ checkedAt: "2026-10-22T07:00:00Z", result: "<script>", release: sha }));
    assert.equal(await updateStatus(status), null, "unknown results are ignored");
    await writeFile(status, "{not json");
    assert.equal(await updateStatus(status), null, "a half-written file is ignored");

    assert.equal((await catalogConnection(async () => ({}))).connected, true);
    const down = await catalogConnection(async () => { throw new CatalogError("Supplier connection is unavailable."); });
    assert.deepEqual([down.connected, down.error], [false, "Supplier connection is unavailable."]);
    await assert.rejects(catalogConnection(async () => { throw new TypeError("bug"); }), TypeError, "programming errors still surface");

    const row = (fields) => ({ deletedAt: null, enabled: true, status: "SYNCED", error: null, lastSuccessAt: null, nextRunAt: null, ...fields });
    assert.deepEqual(inventoryHealth([]), { enabled: 0, review: 0, lastSuccessAt: null, nextRunAt: null });
    assert.deepEqual(inventoryHealth([
      row({ lastSuccessAt: "2026-10-22T07:00:00.000Z", nextRunAt: "2026-10-22T07:05:00.000Z" }),
      row({ lastSuccessAt: "2026-10-22T07:02:00.000Z", nextRunAt: "2026-10-22T07:03:00.000Z", status: "FAILED", error: "Mapping changed" }),
      row({ enabled: false, status: "NOT_ENROLLED" }),
      row({ deletedAt: "2026-10-21T00:00:00.000Z", status: "DELETED", error: "Gone", lastSuccessAt: "2026-10-22T08:00:00.000Z" }),
    ]), { enabled: 2, review: 1, lastSuccessAt: "2026-10-22T07:02:00.000Z", nextRunAt: "2026-10-22T07:03:00.000Z" }, "deleted listings never count");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await server.close();
  }
});
