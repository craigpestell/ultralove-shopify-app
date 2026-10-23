import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";
import { browsesFeed, catalogCache, catalogKey, CATALOG_CACHE_MS } from "../app/catalog-cache.ts";

test("only Catalog browses the feed, and each feed page has one cache key", () => {
  const params = (query) => new URLSearchParams(query);
  assert.equal(browsesFeed(params("")), true);
  assert.equal(browsesFeed(params("view=catalog&search=x")), true);
  for (const query of ["view=selection", "view=review&job=a", "view=imports", "job=a"]) assert.equal(browsesFeed(params(query)), false, query);
  assert.equal(catalogKey(params("shop=lab&host=h&id_token=t&embedded=1&view=catalog")), "");
  assert.equal(catalogKey(params("after_id=0&category_id=0&search=%20")), "");
  assert.equal(catalogKey(params("view=catalog&search=%20lube%20&category_id=5&after_id=50&shop=lab")), "search=lube&category_id=5&after_id=50");
  assert.equal(catalogKey(params("after_id=50&search=lube&category_id=5")), catalogKey(params("search=lube&category_id=5&after_id=50")));
});

test("cached pages expire and the oldest page goes first when full", () => {
  let now = 0;
  const cache = catalogCache(() => now, CATALOG_CACHE_MS, 2);
  cache.set("a", 1);
  now = CATALOG_CACHE_MS - 1;
  assert.equal(cache.get("a"), 1);
  now = CATALOG_CACHE_MS;
  assert.equal(cache.get("a"), null, "expired after the TTL");
  cache.set("a", 1); cache.set("b", 2); cache.set("a", 3); cache.set("c", 4);
  assert.equal(cache.get("b"), null, "least recently stored entry is dropped");
  assert.equal(cache.get("a"), 3);
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("client navigations to Catalog reuse cached feed pages and never cache failures", async () => {
  const shop = "ultralove-integration-lab.myshopify.com";
  const server = await createServer({
    configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom",
    plugins: [{
      name: "test-catalog-cache",
      enforce: "pre",
      load(id) {
        if (id.endsWith("/app/shopify.server.ts")) return `
          export const auth = { reject: false };
          export async function authenticateRetailer() {
            if (auth.reject) throw new Response("Forbidden", {status:403});
            return {session:{shop:${JSON.stringify(shop)}}};
          }`;
        if (id.endsWith("/app/db.server.ts")) return "export default {};";
        if (id.endsWith("/app/imports.server.ts")) return `
          export async function createPreview() {}
          export async function queueJob() {}
          export async function importScreen() { return { selected:[1], markup:"25.00", markups:{}, job:null, history:[] }; }`;
        if (id.endsWith("/app/catalog.server.ts")) return `
          export class CatalogError extends Error {}
          export const feed = { calls: [], reject: false };
          export async function validateSelection() {}
          export async function productsPage(filters) {
            feed.calls.push(filters);
            if (feed.reject) throw new CatalogError("Feed unavailable");
            return { products: [{ id: filters.after_id + 1 }], hidden: 1, next_after_id: 0, has_more: false };
          }
          export async function allCategories() { return { categories: [{ id: 5, name: "Lube" }] }; }`;
      },
    }],
  });
  const realFetch = globalThis.fetch;
  try {
    const { loader, clientLoader } = await server.ssrLoadModule("/app/routes/app._index.tsx");
    const { loader: feedLoader } = await server.ssrLoadModule("/app/routes/app.catalog-feed.ts");
    const { feed } = await server.ssrLoadModule("/app/catalog.server.ts");
    const { auth } = await server.ssrLoadModule("/app/shopify.server.ts");
    const url = (query) => `https://app.example/app${query}`;
    const documentRequest = (query) => new Request(url(query), { headers: { "Sec-Fetch-Dest": "iframe" } });
    const fetchRequest = (query) => new Request(url(query), { headers: { "Sec-Fetch-Dest": "empty" } });

    // Document loads render the feed on the server; fetch requests leave it to the client.
    const rendered = await loader({ request: documentRequest("?shop=lab") });
    assert.equal(rendered.products.products[0].id, 1);
    assert.equal(rendered.products.hidden, 1, "wholesale-only count is part of the page");
    assert.equal(rendered.clientFeed, false);
    const deferred = await loader({ request: fetchRequest("?view=catalog") });
    assert.equal(deferred.products, null);
    assert.equal(deferred.clientFeed, true);
    assert.equal((await loader({ request: documentRequest("?view=selection") })).products, null, "Selection does not read the feed");
    assert.equal(feed.calls.length, 1);

    // The feed route serves one page, validates filters and authenticates first.
    const page = await feedLoader({ request: new Request(url("/catalog-feed?after_id=50&search=lube")) });
    assert.deepEqual(page.data.products.products.map((product) => product.id), [51]);
    assert.equal(page.init.headers["Cache-Control"], "no-store");
    assert.deepEqual(feed.calls.at(-1), { search: "lube", category_id: undefined, after_id: 50 });
    assert.equal((await feedLoader({ request: new Request(url("/catalog-feed?after_id=x")) })).init.status, 400);
    feed.reject = true;
    const failed = await feedLoader({ request: new Request(url("/catalog-feed")) });
    assert.equal(failed.init.status, 502);
    assert.equal(failed.data.error, "Feed unavailable");
    feed.reject = false;
    auth.reject = true;
    const before = feed.calls.length;
    await assert.rejects(feedLoader({ request: new Request(url("/catalog-feed")) }), (error) => error.status === 403);
    assert.equal(feed.calls.length, before, "nothing is read before authentication");
    auth.reject = false;

    // clientLoader: the server-rendered page seeds the cache, so coming back costs no feed request.
    const fetched = [];
    let feedStatus = 200;
    globalThis.fetch = async (input) => {
      fetched.push(String(input));
      const key = new URL(String(input), "https://app.example").searchParams;
      const after = Number(key.get("after_id") || 0);
      return feedStatus === 200
        ? Response.json({ products: { products: [{ id: after + 1 }], hidden: 0, next_after_id: 0, has_more: false }, categories: { categories: [] }, error: null })
        : Response.json({ products: null, categories: null, error: "Feed unavailable" }, { status: feedStatus });
    };
    const client = (query, serverResult) => clientLoader({ request: new Request(url(query)), serverLoader: async () => serverResult });
    const hydrated = await client("?shop=lab&view=catalog", rendered);
    assert.equal(hydrated, rendered);
    const screen = { ...deferred, selected: [1, 2] };
    const back = await client("?shop=lab&host=h", screen);
    assert.equal(fetched.length, 0, "returning to Catalog reuses the cached page");
    assert.deepEqual(back.products, rendered.products);
    assert.deepEqual(back.selected, [1, 2], "saved configuration still comes from the server");
    assert.equal(back.error, null);

    const next = await client("?view=catalog&after_id=50", screen);
    assert.deepEqual(fetched, ["/app/catalog-feed?after_id=50"]);
    assert.equal(next.products.products[0].id, 51);
    await client("?after_id=50&view=catalog", screen);
    assert.equal(fetched.length, 1, "the next page is cached too");

    const notCatalog = { ...deferred, clientFeed: false };
    assert.equal(await client("?view=selection", notCatalog), notCatalog);
    assert.equal(fetched.length, 1);

    feedStatus = 502;
    const error = await client("?search=gone", screen);
    assert.equal(error.products, null);
    assert.equal(error.error, "Feed unavailable");
    feedStatus = 200;
    const retried = await client("?search=gone", screen);
    assert.equal(fetched.length, 3, "a failed page is fetched again");
    assert.equal(retried.error, null);
    globalThis.fetch = async () => { throw new TypeError("offline"); };
    assert.match((await client("?search=offline", screen)).error, /could not be loaded/);
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }
});
