import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, redirect, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticateShopAdmin } from "../shopify.server";
import { isApprovedShop } from "../shop-policy.server";
import { savedConfiguration } from "../imports.server";
import { currentRelease } from "../settings.server";
import { WorkspaceProvider } from "../workspace";
import { AdminLoadingBar } from "../network-state";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateShopAdmin(request);
  const url = new URL(request.url);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  // Stores UltraLove has not approved only reach the waiting-for-approval page.
  if (!(await isApprovedShop(session.shop))) {
    if (url.pathname !== "/app/pending") throw redirect(`/app/pending${url.search}`);
    return { apiKey, shop: session.shop, saved: null, release: null };
  }
  const [saved, release] = await Promise.all([savedConfiguration(session.shop), currentRelease()]);
  return { apiKey, shop: session.shop, saved, release: release?.release ?? null };
};

export default function App() {
  const { apiKey, shop, saved, release } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <AdminLoadingBar />
      {saved ? <WorkspaceProvider shop={shop} saved={saved} release={release}><Outlet /></WorkspaceProvider> : <Outlet />}
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
