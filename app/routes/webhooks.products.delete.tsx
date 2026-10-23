import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { assertShopDomain } from "../shop-policy.server";
import { deletedProductId, markListingDeleted } from "../listing-lifecycle.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const body = request.clone();
  const { shop, topic } = await authenticate.webhook(request);
  assertShopDomain(shop);
  if (topic !== "PRODUCTS_DELETE") throw new Response("Unexpected webhook topic.", { status: 400 });
  // Keep numeric Shopify IDs exact even beyond JavaScript's safe integer range.
  const payload: unknown = JSON.parse(await body.text(), (key, value: unknown, context?: { source: string }) =>
    key === "id" && typeof value === "number" ? context?.source ?? value : value);
  await markListingDeleted(shop, deletedProductId(payload));
  console.info("Shopify product deletion recorded.", shop);
  return new Response();
};
