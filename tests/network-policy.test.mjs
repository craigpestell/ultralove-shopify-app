import assert from "node:assert/strict";
import { test } from "node:test";
import { requestPending, sameDestination } from "../app/network-policy.ts";

const form = (entries) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
};

test("idle navigation is never pending", () => {
  assert.equal(requestPending({ state: "idle" }), false);
  assert.equal(requestPending({ state: "idle" }, { intent: "preview" }), false);
});

test("submissions match by intent, method and extra fields", () => {
  const submitting = { state: "submitting", formMethod: "POST", formData: form({ intent: "enable", supplierId: "42" }),
    location: { pathname: "/app/inventory", search: "" } };
  assert.equal(requestPending(submitting), true);
  assert.equal(requestPending(submitting, { intent: "enable" }), true);
  assert.equal(requestPending(submitting, { intent: ["pause", "enable"] }), true);
  assert.equal(requestPending(submitting, { intent: "pause" }), false);
  assert.equal(requestPending(submitting, { method: "GET" }), false);
  assert.equal(requestPending(submitting, { intent: "enable", fields: { supplierId: "42" } }), true);
  assert.equal(requestPending(submitting, { intent: "enable", fields: { supplierId: "7" } }), false);
  assert.equal(requestPending(submitting, { to: "/app/inventory" }), false, "a submission is not a link load");
});

test("GET form submissions match by method without matching links", () => {
  const search = { state: "loading", formMethod: "GET", formData: form({ search: "amber" }),
    location: { pathname: "/app", search: "?view=catalog&search=amber" } };
  assert.equal(requestPending(search, { method: "GET" }), true);
  assert.equal(requestPending(search, { to: "/app?view=catalog&search=amber" }), false);
});

test("link loads match only their own destination, regardless of parameter order", () => {
  const loading = { state: "loading", location: { pathname: "/app", search: "?shop=lab.myshopify.com&view=selection" } };
  assert.equal(requestPending(loading, { to: "/app?view=selection&shop=lab.myshopify.com" }), true);
  assert.equal(requestPending(loading, { to: "/app?view=catalog&shop=lab.myshopify.com" }), false);
  assert.equal(requestPending(loading, { to: "/app/inventory?view=selection&shop=lab.myshopify.com" }), false);
  assert.equal(requestPending(loading, { intent: "preview" }), false);
});

test("destinations ignore React Router's index marker", () => {
  assert.equal(sameDestination("/app?view=review", { pathname: "/app", search: "?index&view=review" }), true);
  assert.equal(sameDestination("/app?view=review&job=1", { pathname: "/app", search: "?view=review" }), false);
});
