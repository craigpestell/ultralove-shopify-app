import assert from "node:assert/strict";
import { test } from "node:test";
import { markupOverrides, markupPercent, pricingSignature, retailPrice, selectedOverrides } from "../app/pricing-policy.ts";

test("global and per-parent markups share strict percent validation", () => {
  for (const [value, expected] of [["0", "0.00"], ["25", "25.00"], ["0.01", "0.01"], ["1000", "1000.00"], [" 25.5 ", "25.50"]]) {
    assert.equal(markupPercent(value), expected);
    assert.deepEqual(markupOverrides({ 100: value }, [100]), { 100: expected });
  }
  for (const invalid of ["", "-1", "1000.01", "1e2", "25.001", "NaN", null, "01", 25]) {
    assert.throws(() => markupPercent(invalid));
    assert.throws(() => markupOverrides({ 100: invalid }, [100]), /Product #100/);
  }
  for (const invalid of [null, [], "{}", { 101: "25" }, { "0100": "25" }, { invalid: "25" }]) {
    assert.throws(() => markupOverrides(invalid, [100]));
  }
  const ids = Array.from({ length: 1250 }, (_, index) => index + 1);
  const overrides = Object.fromEntries(ids.map((id) => [id, "25"]));
  assert.equal(Object.keys(markupOverrides(overrides, ids)).length, 1250);
  assert.equal(markupOverrides(overrides, ids)[1250], "25.00");
});

test("CAD override prices use exact half-up rounding for zero, fractions and every variant", () => {
  for (const [wholesale, markup, expected] of [
    ["12.50", "25", "15.63"], ["12.50", "50", "18.75"],
    ["0.005", "0", "0.01"], ["0.0049", "0", "0.00"],
    ["0.01", "50", "0.02"], ["0", "1000", "0.00"],
    [null, "50", "0.00"], ["", "50", "0.00"], ["99.99", "1000", "1099.89"],
    ["1.235", "0.01", "1.24"], ["999999999999999.99", "0", "999999999999999.99"],
  ]) assert.equal(retailPrice(wholesale, markup), expected);
  for (const invalid of ["-1", "1e3", "NaN", "1.".repeat(100)]) assert.throws(() => retailPrice(invalid, "25"));
  assert.throws(() => retailPrice("12.50", "25.001"));
});

test("defaults preserve overrides, deselection prunes only removed parents, bulk reset restores defaults", () => {
  const overrides = { 100: "50", 101: "0" };
  assert.equal(retailPrice("12.50", overrides[100] ?? "25"), "18.75");
  assert.equal(retailPrice("12.50", overrides[100] ?? "75"), "18.75");
  assert.deepEqual(selectedOverrides(overrides, [100]), { 100: "50" });
  assert.deepEqual(selectedOverrides({}, [100, 101]), {});
  assert.equal(retailPrice("12.50", {}[100] ?? "75"), "21.88");
  assert.equal(pricingSignature([101, 100], "25", overrides), pricingSignature([100, 101], "25.00", { 101: "0.00", 100: "50.00" }));
  assert.notEqual(pricingSignature([100], "25", overrides), pricingSignature([100], "25", {}));
});
