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

/**
 * Stores UltraLove has approved to browse and import its catalog, from the comma-separated
 * APPROVED_SHOPS. Any store can install the app; the rest see the waiting-for-approval page.
 */
export async function approvedShops(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  return shopList(env.APPROVED_SHOPS, [LAB_SHOP]);
}

export async function isApprovedShop(shop: unknown, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return isShopDomain(shop) && (await approvedShops(env)).includes(shop);
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
