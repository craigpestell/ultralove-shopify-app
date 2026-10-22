import assert from "node:assert/strict";
import { test } from "node:test";
import { blocking, feedVersionLabel, feedVersionVerdict, KNOWN_VERSION, SUPPORTED_MAJOR } from "../app/feed-version.ts";
import { categoriesPage } from "../app/catalog.server.ts";

test("the supported major version of the feed is read, any other major pauses imports and sync", () => {
  assert.equal(SUPPORTED_MAJOR, Number(KNOWN_VERSION.split(".")[0]));
  assert.deepEqual(feedVersionVerdict("1.2"), { version: "1.2", result: "compatible", allowed: true, reason: null });
  assert.deepEqual(feedVersionVerdict("1.0"), { version: "1.0", result: "compatible", allowed: true, reason: null });
  assert.deepEqual(feedVersionVerdict("1.10"), { version: "1.10", result: "newer-minor", allowed: true, reason: null },
    "minor versions compare as numbers, not text");
  assert.deepEqual(feedVersionVerdict(undefined), { version: null, result: "unversioned", allowed: true, reason: null },
    "a feed from before versioning (production until it is deployed) keeps importing");
  assert.equal(feedVersionVerdict(null).result, "unversioned");
  const breaking = feedVersionVerdict("2.0");
  assert.deepEqual([breaking.version, breaking.result, breaking.allowed], ["2.0", "unsupported", false]);
  assert.match(breaking.reason, /schema 2\.0, but this app supports 1\.x/);
  assert.equal(feedVersionVerdict("0.9").result, "unsupported");
  for (const value of ["2", "1.2.0", "v1.2", "", 1.2, {}, "1.2<script>"]) {
    const verdict = feedVersionVerdict(value);
    assert.deepEqual([verdict.version, verdict.result, verdict.allowed], [null, "invalid", false], `unreadable: ${JSON.stringify(value)}`);
  }
  assert.deepEqual(["compatible", "newer-minor", "unversioned", "unavailable"].map(blocking), [false, false, false, false],
    "an unreachable feed is reported by the import or sync itself, not as a version block");
  assert.deepEqual(["unsupported", "invalid"].map(blocking), [true, true]);
  assert.match(feedVersionLabel("unversioned"), /read as 1\.1/);
});

test("category pages pass the feed's schema version through", async () => {
  const page = { next_after_id: 0, has_more: false, categories: [] };
  assert.equal((await categoriesPage(0, async () => ({ ...page, schema_version: "1.2" }))).schemaVersion, "1.2");
  assert.equal((await categoriesPage(0, async () => page)).schemaVersion, undefined);
});
