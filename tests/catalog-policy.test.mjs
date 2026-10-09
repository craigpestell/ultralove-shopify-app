import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionIds, browseFilters } from "../app/catalog-policy.ts";

test("selection accepts exactly 50 parents and never an implicit entire catalog", () => {
  assert.equal(selectionIds(Array.from({length: 50}, (_, i) => i + 1)).length, 50);
  assert.deepEqual(selectionIds([3, 1, 2]), [1, 2, 3]);
  assert.deepEqual(selectionIds([]), []);
  for (const value of [null, [1, 1], ["1"], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], Array.from({length: 51}, (_, i) => i + 1)]) {
    assert.throws(() => selectionIds(value));
  }
});

test("browse filters combine literal search, category and bounded pagination", () => {
  assert.deepEqual(browseFilters(new URL("https://app.example/app?search=SKU-123&category_id=5&after_id=10")), {
    search: "SKU-123", category_id: 5, after_id: 10, categoryAfter: 0,
  });
  for (const query of ["after_id=-1", "after_id=1.5", "category_id=1&category_id=2", "search=a&search=b", `search=${"a".repeat(101)}`]) {
    assert.throws(() => browseFilters(new URL(`https://app.example/app?${query}`)));
  }
});
