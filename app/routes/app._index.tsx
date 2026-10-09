import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateLabAdmin } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateLabAdmin(request);
  return { shop: session.shop };
};

export default function Index() {
  const { shop } = useLoaderData<typeof loader>();
  return (
    <s-page heading="UltraLove Dropshipping Lab">
      <s-section heading="Retailer catalog">
        <s-paragraph>Connected Shopify test store: {shop}</s-paragraph>
        <s-paragraph>
          The application foundation is ready. Catalog browsing, product
          selection and draft-import progress are not connected yet.
        </s-paragraph>
      </s-section>
      <s-section heading="Test-only safeguards">
        <s-unordered-list>
          <s-list-item>This interface does not create or publish products.</s-list-item>
          <s-list-item>Existing catalog and inventory workers are unchanged.</s-list-item>
          <s-list-item>No orders, payments, notifications or shipments are triggered.</s-list-item>
          <s-list-item>Production and independent retailer stores are not enabled.</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
