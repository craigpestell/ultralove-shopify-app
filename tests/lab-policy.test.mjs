import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLabLogin,
  assertLabRequest,
  assertLabShop,
  LAB_SHOP,
} from "../app/lab-policy.server.ts";

test("only the exact approved store is accepted", () => {
  assert.doesNotThrow(() => assertLabShop(LAB_SHOP));
  for (const shop of [
    undefined, "", "ultralove.ca", "another.myshopify.com",
    `${LAB_SHOP}.evil.example`, `https://${LAB_SHOP}`, LAB_SHOP.toUpperCase(),
  ]) {
    assert.throws(() => assertLabShop(shop), (error) => error instanceof Response && error.status === 403);
  }
});

test("query parameters are checked before starting authentication", async () => {
  await assertLabRequest(new Request(`https://app.example/app?shop=${LAB_SHOP}`));
  await assertLabRequest(new Request("https://app.example/app"));
  await assert.rejects(
    assertLabRequest(new Request("https://app.example/app?shop=another.myshopify.com")),
    (error) => error instanceof Response && error.status === 403,
  );
  await assert.rejects(
    assertLabRequest(new Request(`https://app.example/app?shop=${LAB_SHOP}&shop=${LAB_SHOP}`)),
    (error) => error instanceof Response && error.status === 400,
  );
});

test("login checks the form without consuming the SDK's request body", async () => {
  const request = new Request("https://app.example/auth/login", {
    method: "POST",
    body: new URLSearchParams({ shop: LAB_SHOP }),
  });
  await assertLabLogin(request);
  assert.equal((await request.formData()).get("shop"), LAB_SHOP);
});

test("foreign, missing and duplicate login shops are rejected", async () => {
  for (const [body, status] of [
    [new URLSearchParams({ shop: "another.myshopify.com" }), 403],
    [new URLSearchParams(), 400],
    [new URLSearchParams([["shop", LAB_SHOP], ["shop", LAB_SHOP]]), 400],
  ]) {
    await assert.rejects(
      assertLabLogin(new Request("https://app.example/auth/login", { method: "POST", body })),
      (error) => error instanceof Response && error.status === status,
    );
  }
});
