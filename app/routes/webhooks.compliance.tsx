import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { deleteShopData } from "../shop-data.server";

// Shopify's mandatory privacy topics. authenticate.webhook answers 401 to an invalid signature.
// The app stores no customer data: products, prices, stock and import history only.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      console.info("Privacy request needs no action: no customer data is stored.", topic, shop);
      break;
    case "SHOP_REDACT":
      await deleteShopData(shop);
      console.info("Deleted all stored data for a store after shop/redact.", shop);
      break;
    default:
      throw new Response("Unexpected webhook topic.", { status: 400 });
  }
  return new Response();
};
