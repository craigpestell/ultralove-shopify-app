// The integration lab store. It stays approved when APPROVED_SHOPS is unset, and it is the
// default operator store that sees the host's release and update controls.
export const LAB_SHOP = "ultralove-integration-lab.myshopify.com";
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isShopDomain(shop: unknown): shop is string {
  return typeof shop === "string" && SHOP_DOMAIN.test(shop);
}

/** Every app-owned read and write is keyed by an exact myshopify.com domain. */
export function assertShopDomain(shop: unknown): asserts shop is string {
  if (!isShopDomain(shop)) {
    console.warn("Rejected an invalid Shopify store identifier.");
    throw new Response("Invalid Shopify store.", { status: 403 });
  }
}

function shopList(value: string | undefined, fallback: string[]) {
  if (value === undefined || !value.trim()) return fallback;
  const shops = value.split(",").map((shop) => shop.trim().toLowerCase()).filter(Boolean);
  const invalid = shops.filter((shop) => !isShopDomain(shop));
  if (invalid.length) console.warn("Ignored invalid store domains in the approved store list.", invalid.length);
  return shops.filter(isShopDomain);
}

const STORE_LIST_MS = 5 * 60 * 1000;
const STORE_LIST_RETRY_MS = 60 * 1000;
type StoreList = { stores: string[] | null; nextReadAt: number; reading?: Promise<void> };
const wordpress: StoreList = { stores: null, nextReadAt: 0 };
const readWordPress = async () => (await import("./catalog.server")).approvedStoreList();

/**
 * Stores UltraLove approved to browse and import its catalog: the "Approved Shopify store" list in
 * WordPress (feed 1.6), plus the comma-separated APPROVED_SHOPS, which defaults to the lab. The
 * WordPress list is read at most every five minutes. When a read fails, the last list read stays in
 * use; before the first successful read, only APPROVED_SHOPS applies. Any store can install the
 * app; the rest see the waiting-for-approval page.
 */
export async function approvedShops(env: NodeJS.ProcessEnv = process.env, read: () => Promise<string[]> = readWordPress,
  cache: StoreList = wordpress): Promise<string[]> {
  // Requests that arrive while the list is being read wait for that one read.
  if (Date.now() >= cache.nextReadAt) cache.reading ??= (async () => {
    try {
      cache.stores = (await read()).filter(isShopDomain);
      cache.nextReadAt = Date.now() + STORE_LIST_MS;
    } catch (error) {
      console.warn("Approved store list could not be read from WordPress; using the last list read.",
        error instanceof Error ? error.message : "Unknown failure");
      cache.nextReadAt = Date.now() + STORE_LIST_RETRY_MS;
    } finally {
      cache.reading = undefined;
    }
  })();
  await cache.reading;
  return [...new Set([...shopList(env.APPROVED_SHOPS, [LAB_SHOP]), ...cache.stores ?? []])];
}

export async function isApprovedShop(shop: unknown, env: NodeJS.ProcessEnv = process.env,
  read?: () => Promise<string[]>, cache?: StoreList): Promise<boolean> {
  return isShopDomain(shop) && (await approvedShops(env, read, cache)).includes(shop);
}

/** The store that manages the app host itself: release details, update checks and automatic updates. */
export function isOperatorShop(shop: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return isShopDomain(shop) && shop === (env.OPERATOR_SHOP?.trim().toLowerCase() || LAB_SHOP);
}

/** Rejects ambiguous requests before the Shopify SDK picks one of several shop parameters. */
export function assertSingleShop(request: Request): void {
  if (new URL(request.url).searchParams.getAll("shop").length > 1) {
    console.warn("Rejected a Shopify request with ambiguous store parameters.");
    throw new Response("Supply exactly one shop parameter.", { status: 400 });
  }
}

export async function assertSingleLoginShop(request: Request): Promise<void> {
  assertSingleShop(request);
  if (request.method === "POST" && (await request.clone().formData()).getAll("shop").length !== 1) {
    console.warn("Rejected a Shopify login without one store identifier.");
    throw new Response("Supply exactly one shop field.", { status: 400 });
  }
}
