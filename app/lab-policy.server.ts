export const LAB_SHOP = "ultralove-integration-lab.myshopify.com";

export function assertLabShop(shop: unknown): asserts shop is string {
  if (shop !== LAB_SHOP) {
    console.warn("Rejected a Shopify connection outside the approved lab store.");
    throw new Response("This application is restricted to the UltraLove test store.", {
      status: 403,
    });
  }
}

export async function assertLabRequest(request: Request): Promise<void> {
  const shops = new URL(request.url).searchParams.getAll("shop");
  if (shops.length > 1) {
    console.warn("Rejected a Shopify request with ambiguous store parameters.");
    throw new Response("Supply exactly one shop parameter.", { status: 400 });
  }
  if (shops.length) {
    assertLabShop(shops[0]);
  }
}

export async function assertLabLogin(request: Request): Promise<void> {
  await assertLabRequest(request);
  if (request.method === "POST") {
    const shops = (await request.clone().formData()).getAll("shop");
    if (shops.length !== 1) {
      console.warn("Rejected a Shopify login without one store identifier.");
      throw new Response("Supply exactly one shop field.", { status: 400 });
    }
    assertLabShop(shops[0]);
  }
}
