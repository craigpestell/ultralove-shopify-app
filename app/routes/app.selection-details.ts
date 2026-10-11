import type { LoaderFunctionArgs } from "react-router";
import { data } from "react-router";
import { authenticateLabAdmin } from "../shopify.server";
import { CATALOG_BATCH_SIZE, selectionIds } from "../catalog-policy";
import { CatalogError, selectedProducts } from "../catalog.server";

const headers = { "Cache-Control": "no-store" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticateLabAdmin(request);
  let ids: number[];
  try {
    const values = new URL(request.url).searchParams.getAll("ids");
    if (values.length !== 1 || values[0].length > 1000) throw new Error("Supply exactly one bounded selected-product list.");
    ids = selectionIds(JSON.parse(values[0]));
    if (!ids.length || ids.length > CATALOG_BATCH_SIZE) throw new Error("Request 1-50 selected product details at a time.");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.warn("Selected product details request rejected.", error.message);
    return data({ products: [], error: error.message }, { status: 400, headers });
  }
  try {
    return data({ products: await selectedProducts(ids), error: null }, { headers });
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    console.error("Selected product details failed.", error.message);
    return data({ products: [], error: error.message }, { status: 502, headers });
  }
};
