import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionIds, pageSelection, browseFilters, supplierText } from "../app/catalog-policy.ts";

test("supplier labels decode HTML entities without rendering supplier markup", () => {
  assert.equal(supplierText("Lotions &amp; Dusts"), "Lotions & Dusts");
  assert.equal(supplierText("Name<br>Details &#039;quoted&#039;"), "Name Details 'quoted'");
  assert.equal(supplierText("&#x1F600;"), "\u{1F600}");
  assert.equal(supplierText("&lt;script&gt;"), "<script>");
});

test("selection accepts more than one page while requiring explicit distinct parent IDs", () => {
  assert.equal(selectionIds(Array.from({length: 1250}, (_, i) => i + 1)).length, 1250);
  assert.deepEqual(selectionIds([3, 1, 2]), [1, 2, 3]);
  assert.deepEqual(selectionIds([]), []);
  for (const value of [null, [1, 1], ["1"], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
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

test("page selection selects every visible parent and preserves selections on other pages", () => {
  const page = Array.from({ length: 50 }, (_, index) => index + 1);
  assert.deepEqual(pageSelection([], page, true), page);
  assert.deepEqual(pageSelection([1, 2], page, true), page);
  assert.deepEqual(pageSelection(page, page, true), page);
  assert.deepEqual(pageSelection([1, 2, 100], [1, 2, 3], true), [1, 2, 3, 100]);
  assert.deepEqual(pageSelection([1, 2, 100], [1, 2, 3], false), [100]);
  assert.deepEqual(pageSelection([100], [], true), [100]);
  assert.deepEqual(pageSelection([100], [], false), [100]);
  assert.deepEqual(pageSelection([100], page, true), [...page, 100]);
  const next = Array.from({ length: 50 }, (_, index) => index + 51);
  assert.equal(pageSelection(page, next, true).length, 100);
  assert.deepEqual(pageSelection(page, page, false), []);
});
