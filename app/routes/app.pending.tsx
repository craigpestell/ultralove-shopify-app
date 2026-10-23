import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateShopAdmin } from "../shopify.server";
import { isApprovedShop } from "../shop-policy.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateShopAdmin(request);
  if (await isApprovedShop(session.shop)) throw redirect(`/app${new URL(request.url).search}`);
  return { shop: session.shop };
};

export default function Pending() {
  const { shop } = useLoaderData<typeof loader>();
  return <s-page heading="UltraLove Catalog">
    <s-section heading="Waiting for UltraLove approval">
      <s-paragraph>
        UltraLove Catalog is for UltraLove&apos;s approved retailers. Once UltraLove approves this store, you can browse
        its catalog, set your prices and import products here.
      </s-paragraph>
      <s-paragraph>
        To ask for approval, contact UltraLove and give them this store address: <s-text type="strong">{shop}</s-text>
      </s-paragraph>
      <s-paragraph>Nothing in your store has been changed. Reopen the app after you hear back.</s-paragraph>
    </s-section>
  </s-page>;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
