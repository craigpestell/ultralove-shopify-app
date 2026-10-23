import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { stopShopWork } from "../shop-data.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled,
  // so stopping a store's work is idempotent.
  await stopShopWork(shop);

  return new Response();
};
