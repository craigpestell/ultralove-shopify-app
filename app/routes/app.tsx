import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticateLabAdmin } from "../shopify.server";
import { savedConfiguration } from "../imports.server";
import { WorkspaceProvider } from "../workspace";
import { AdminLoadingBar } from "../network-state";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateLabAdmin(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "", shop: session.shop, saved: await savedConfiguration(session.shop) };
};

export default function App() {
  const { apiKey, shop, saved } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <AdminLoadingBar />
      <WorkspaceProvider shop={shop} saved={saved}><Outlet /></WorkspaceProvider>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
