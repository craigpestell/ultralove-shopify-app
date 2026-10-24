import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvedShops,
  assertShopDomain,
  assertSingleLoginShop,
  assertSingleShop,
  isApprovedShop,
  isOperatorShop,
  LAB_SHOP,
} from "../app/shop-policy.server.ts";

test("app data is only keyed by exact myshopify.com domains", () => {
  assert.doesNotThrow(() => assertShopDomain(LAB_SHOP));
  assert.doesNotThrow(() => assertShopDomain("source-adult.myshopify.com"));
  for (const shop of [
    undefined, "", "ultralove.ca", `${LAB_SHOP}.evil.example`, `https://${LAB_SHOP}`, LAB_SHOP.toUpperCase(),
    "-bad.myshopify.com", "a.b.myshopify.com",
  ]) {
    assert.throws(() => assertShopDomain(shop), (error) => error instanceof Response && error.status === 403);
  }
});

const unread = () => ({ stores: null, nextReadAt: 0 });
const offline = async () => { throw new Error("No supplier connection in tests"); };

test("only listed stores are approved, and the lab stays approved by default", async () => {
  assert.deepEqual(await approvedShops({}, offline, unread()), [LAB_SHOP]);
  assert.deepEqual(await approvedShops({ APPROVED_SHOPS: "  " }, offline, unread()), [LAB_SHOP]);
  const env = { APPROVED_SHOPS: " Source-Adult.myshopify.com, ultralove.ca,another.myshopify.com ," };
  assert.deepEqual(await approvedShops(env, offline, unread()), ["source-adult.myshopify.com", "another.myshopify.com"], "invalid entries are dropped");
  assert.equal(await isApprovedShop("source-adult.myshopify.com", env, offline, unread()), true);
  assert.equal(await isApprovedShop(LAB_SHOP, env, offline, unread()), false, "an explicit list replaces the lab default");
  assert.equal(await isApprovedShop("ultralove.ca", env, offline, unread()), false);
  assert.equal(await isApprovedShop(undefined, env, offline, unread()), false);
});

test("stores approved in WordPress are added, cached, and kept when a later read fails", async () => {
  const cache = unread();
  let reads = 0;
  let answer = async () => { reads++; return ["retailer.myshopify.com", "bad.example"]; };
  const read = () => answer();
  assert.deepEqual(await approvedShops({}, read, cache), [LAB_SHOP, "retailer.myshopify.com"], "invalid WordPress entries are dropped");
  assert.deepEqual(await approvedShops({}, read, cache), [LAB_SHOP, "retailer.myshopify.com"]);
  assert.equal(reads, 1, "the list is read at most every five minutes");
  cache.nextReadAt = 0;
  answer = offline;
  assert.deepEqual(await approvedShops({}, read, cache), [LAB_SHOP, "retailer.myshopify.com"], "a failed read keeps the last list");
  assert.ok(cache.nextReadAt - Date.now() <= 60 * 1000, "a failed read retries within a minute");
  cache.nextReadAt = 0;
  answer = async () => [];
  assert.equal(await isApprovedShop("retailer.myshopify.com", {}, read, cache), false, "withdrawing approval in WordPress takes effect");
});

test("only the operator store manages the app host", () => {
  assert.equal(isOperatorShop(LAB_SHOP, {}), true);
  assert.equal(isOperatorShop("source-adult.myshopify.com", {}), false);
  assert.equal(isOperatorShop("source-adult.myshopify.com", { OPERATOR_SHOP: "source-adult.myshopify.com" }), true);
  assert.equal(isOperatorShop(LAB_SHOP, { OPERATOR_SHOP: "source-adult.myshopify.com" }), false);
});

test("any single store may start authentication; ambiguous requests are rejected", () => {
  assert.doesNotThrow(() => assertSingleShop(new Request("https://app.example/app?shop=another.myshopify.com")));
  assert.doesNotThrow(() => assertSingleShop(new Request("https://app.example/app")));
  assert.throws(() => assertSingleShop(new Request(`https://app.example/app?shop=${LAB_SHOP}&shop=${LAB_SHOP}`)),
    (error) => error instanceof Response && error.status === 400);
});

test("login checks the form without consuming the SDK's request body", async () => {
  const request = new Request("https://app.example/auth/login", {
    method: "POST",
    body: new URLSearchParams({ shop: "another.myshopify.com" }),
  });
  await assertSingleLoginShop(request);
  assert.equal((await request.formData()).get("shop"), "another.myshopify.com");
});

test("missing and duplicate login shops are rejected", async () => {
  for (const body of [new URLSearchParams(), new URLSearchParams([["shop", LAB_SHOP], ["shop", LAB_SHOP]])]) {
    await assert.rejects(
      assertSingleLoginShop(new Request("https://app.example/auth/login", { method: "POST", body })),
      (error) => error instanceof Response && error.status === 400,
    );
  }
});
