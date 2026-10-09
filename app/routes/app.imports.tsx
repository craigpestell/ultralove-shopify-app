import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateLabAdmin } from "../shopify.server";
import { action as unifiedAction } from "./app._index";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticateLabAdmin(request);
  const url = new URL(request.url);
  url.searchParams.set("view", "imports");
  return redirect(`/app${url.search}`);
};

// Keep previously rendered forms and bookmarked jobs usable in the imports workspace.
export const action = (args: ActionFunctionArgs) => unifiedAction(args);
export function ErrorBoundary() { return boundary.error(useRouteError()); }
export const headers: HeadersFunction = (args) => boundary.headers(args);
