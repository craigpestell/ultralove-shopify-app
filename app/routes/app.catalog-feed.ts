import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticateRetailer } from "../shopify.server";
import { browseFilters } from "../catalog-policy";
import { CatalogError } from "../catalog.server";
import { browseCatalog } from "../catalog-browse.server";

const headers = { "Cache-Control": "no-store" };

// One supplier catalog page for the workspace's client cache (see catalog-cache.ts).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticateRetailer(request);
  let filters;
  try { filters = browseFilters(new URL(request.url)); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    return data({ products: null, categories: null, error: error.message }, { status: 400, headers });
  }
  try {
    return data({ ...(await browseCatalog(filters)), error: null }, { headers });
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    console.error("Catalog browsing failed.", error.message);
    return data({ products: null, categories: null, error: error.message }, { status: 502, headers });
  }
};
