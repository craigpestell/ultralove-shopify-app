import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, Link, redirect, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateLabAdmin } from "../shopify.server";
import db from "../db.server";
import { browseFilters, pageSelection, selectionIds, supplierText } from "../catalog-policy";
import { categoriesPage, CatalogError, productsPage, validateSelection } from "../catalog.server";
import ProductImage from "../product-image";
import "../catalog.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateLabAdmin(request);
  let filters;
  try {
    filters = browseFilters(new URL(request.url));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.warn("Rejected invalid catalog browse filters.");
    throw new Response(error.message, { status: 400 });
  }
  const { categoryAfter, ...productFilters } = filters;
  const saved = await db.catalogSelection.findUnique({ where: { shop: session.shop } });
  const selected = selectionIds(saved ? JSON.parse(saved.productIds) : []);
  try {
    const [products, categories] = await Promise.all([
      productsPage(productFilters), categoriesPage(categoryAfter),
    ]);
    return { shop: session.shop, selected, filters, products, categories, error: null };
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    console.error("Catalog browsing failed.", error.message);
    return data({ shop: session.shop, selected, filters, products: null, categories: null, error: error.message }, { status: 502 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticateLabAdmin(request);
  const form = await request.formData();
  if (form.get("intent") !== "save-selection" || form.getAll("ids").length !== 1 ||
      typeof form.get("ids") !== "string" || String(form.get("ids")).length > 1000) {
    console.warn("Rejected an invalid catalog selection form.");
    return data({ error: "Invalid catalog selection form." }, { status: 400 });
  }
  let ids: number[];
  try {
    ids = selectionIds(JSON.parse(String(form.get("ids"))));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.warn("Rejected invalid selected product IDs.");
    return data({ error: "Select at most 50 distinct supplier product IDs." }, { status: 400 });
  }
  try {
    await validateSelection(ids);
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    console.error("Catalog selection validation failed.", error.message);
    return data({ error: error.message }, { status: 502 });
  }
  await db.catalogSelection.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop, productIds: JSON.stringify(ids) },
    update: { productIds: JSON.stringify(ids) },
  });
  return redirect("/app/imports");
};

function stockLabel(product: { type: string; manage_stock: boolean; stock_quantity: number | null; stock_owner_id: number | null; id: number }) {
  if (product.type === "variable") return "Review stock per variant";
  if (!product.manage_stock) return "Unmanaged stock - review required";
  if (product.stock_quantity === null || product.stock_owner_id !== product.id) return "Unknown/shared stock - review required";
  return product.stock_quantity > 0 ? `${product.stock_quantity} supplier units` : "Out of stock";
}

export default function Index() {
  const { shop, selected, filters, products, categories, error } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const [ids, setIds] = useState(selected);
  const params = new URLSearchParams();
  if (filters.search) params.set("search", filters.search);
  if (filters.category_id) params.set("category_id", String(filters.category_id));
  if (filters.categoryAfter) params.set("category_after", String(filters.categoryAfter));
  const next = new URLSearchParams(params);
  if (products) next.set("after_id", String(products.next_after_id));
  const nextCategories = new URLSearchParams(params);
  if (categories) nextCategories.set("category_after", String(categories.next_after_id));
  const busy = navigation.state !== "idle";
  const pageIds = products?.products.map((product) => product.id) || [];
  const selectedOnPage = pageIds.filter((id) => ids.includes(id)).length;
  const allOnPageSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const pageExceedsLimit = ids.length + pageIds.length - selectedOnPage > 50;

  return (
    <s-page heading="UltraLove supplier catalog">
      <s-section heading="Browse and select">
        <s-paragraph>Test store: {shop}. Select up to 50 parent products; published variants are included when importing later.</s-paragraph>
        <s-paragraph>Saving a selection does not import, publish or sync products, and does not approve order forwarding.</s-paragraph>
        <p><Link to="/app/imports">Review pricing and product imports</Link></p>
        <div className="catalog-browser">
          {error && <p role="alert">{error} <Link to="/app">Retry catalog</Link></p>}
          {result?.error && <p role="alert">{result.error}</p>}
          <Form method="get" className="catalog-filters">
            <label>Search name or SKU <input name="search" defaultValue={filters.search || ""} maxLength={100} /></label>
            <label>Category
              <select name="category_id" aria-label="Category" defaultValue={filters.category_id || 0} key={`${filters.category_id}-${filters.categoryAfter}`}>
                <option value="0">All categories</option>
                {filters.category_id && !categories?.categories.some((category) => category.id === filters.category_id) &&
                  <option value={filters.category_id}>Selected category #{filters.category_id}</option>}
                {categories?.categories.map((category) => <option key={category.id} value={category.id}>{supplierText(category.name)}</option>)}
              </select>
            </label>
            <button type="submit" disabled={busy}>Search catalog</button>
          </Form>
          {categories?.has_more && <p><Link to={`?${nextCategories}`}>More categories</Link></p>}
          <Form method="post">
            <input type="hidden" name="intent" value="save-selection" />
            <input type="hidden" name="ids" value={JSON.stringify(ids)} />
            <p>{ids.length} of 50 selected. Save your selection to continue to pricing. No import runs until you confirm and queue it.</p>
            {pageExceedsLimit && <p id="page-selection-limit" role="status">Selecting all products on this page would exceed the 50-product limit. Clear some selections first or select products individually.</p>}
            <div className="catalog-table">
              <table>
                <caption>Supplier products - prices are wholesale CAD, not your Shopify selling prices.</caption>
                <thead><tr><th scope="col">
                  <label><input type="checkbox" checked={allOnPageSelected}
                    ref={(input) => { if (input) input.indeterminate = selectedOnPage > 0 && !allOnPageSelected; }}
                    disabled={busy || !pageIds.length || pageExceedsLimit}
                    aria-describedby={pageExceedsLimit ? "page-selection-limit" : undefined}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setIds((current) => pageSelection(current, pageIds, checked));
                    }} /> Select all on this page</label>
                </th><th scope="col">Image</th><th scope="col">Product</th><th scope="col">SKU</th><th scope="col">Supplier price</th><th scope="col">Availability</th></tr></thead>
                <tbody>{products?.products.map((product) => (
                  <tr key={product.id}>
                    <td><input type="checkbox" aria-label={`Select supplier product ${product.id}`} checked={ids.includes(product.id)}
                      disabled={!ids.includes(product.id) && ids.length >= 50}
                      onChange={(event) => setIds((current) => event.target.checked ? [...current, product.id] : current.filter((id) => id !== product.id))} /></td>
                    <td><ProductImage image={product.images[0]} name={product.name} /></td>
                    <td>{supplierText(product.name)} <small>#{product.id} - {product.type}</small></td>
                    <td>{product.sku || "Missing SKU - review required"}</td>
                    <td>{product.price === null || product.price === "" ? "Missing price - review required" : `${product.price} CAD`}</td>
                    <td>{stockLabel(product)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {products && !products.products.length && <p>No products match these filters.</p>}
            <p>Selected IDs: {ids.length ? ids.join(", ") : "None"}</p>
            <button type="submit" disabled={busy || Boolean(error)}>Save selection and review pricing</button>
            {" "}<button type="button" disabled={busy || !ids.length} onClick={() => setIds([])}>Clear selection</button>
          </Form>
          <p><Link to={`?${params}`}>First product page</Link>{products?.has_more && <> | <Link to={`?${next}`}>Next 50 products</Link></>}</p>
        </div>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
