import { useCallback, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, Link, redirect, useActionData, useBeforeUnload, useBlocker, useLoaderData, useLocation, useNavigation, useRouteError, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateLabAdmin } from "../shopify.server";
import db from "../db.server";
import { browseFilters, pageSelection, selectionIds, supplierText } from "../catalog-policy";
import { categoriesPage, CatalogError, productsPage, validateSelection } from "../catalog.server";
import { ImportError, importChoices, markupPercent } from "../import-engine";
import { createPreview, importScreen, queueJob } from "../imports.server";
import { markupOverrides, PricingError, pricingSignature, selectedOverrides } from "../pricing-policy";
import type { MarkupOverrides } from "../pricing-policy";
import ProductImage from "../product-image";
import ImportOptions from "../import-options";
import ImportResults from "../import-results";
import "../catalog.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateLabAdmin(request);
  const url = new URL(request.url);
  const jobs = url.searchParams.getAll("job");
  if (jobs.length > 1 || (jobs.length && !/^[a-f0-9]{32}$/.test(jobs[0]))) throw new Response("Invalid import job identifier.", { status: 400 });
  let filters;
  try {
    filters = browseFilters(url);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Response(error.message, { status: 400 });
  }
  const { categoryAfter, ...productFilters } = filters;
  const screen = await importScreen(session.shop, jobs[0] || null);
  try {
    const [products, categories] = await Promise.all([productsPage(productFilters), categoriesPage(categoryAfter)]);
    return { shop: session.shop, ...screen, filters, products, categories, error: null };
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    console.error("Catalog browsing failed.", error.message);
    return data({ shop: session.shop, ...screen, filters, products: null, categories: null, error: error.message }, { status: 502 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticateLabAdmin(request);
  const form = await request.formData();
  const url = new URL(request.url);
  const destination = (job?: string) => {
    if (job) url.searchParams.set("job", job);
    return `/app${url.search}`;
  };
  try {
    const field = (name: string, max = 1000) => {
      const values = form.getAll(name);
      if (values.length !== 1 || typeof values[0] !== "string" || values[0].length > max) {
        throw new ImportError(`Supply exactly one valid ${name} field.`);
      }
      return values[0];
    };
    const intent = field("intent");
    if (intent === "queue" || intent === "retry") {
      const id = field("job");
      if (!/^[a-f0-9]{32}$/.test(id)) throw new ImportError("Invalid import job identifier.");
      await queueJob(session.shop, id, intent === "retry", field("confirm"));
      return redirect(destination(id));
    }
    if (intent !== "preview" && intent !== "save-selection" && intent !== "save-configuration") throw new ImportError("Invalid catalog action.");
    // Legacy preview forms use saved selections and a global-only markup.
    if (intent === "preview" && !form.has("ids")) {
      const job = await createPreview(session.shop, markupPercent(field("markup")), async (query, variables) => {
        const response = await admin.graphql(query, { variables, tries: 1 });
        return response.json();
      }, importChoices(form));
      return redirect(destination(job.id));
    }
    let ids: number[];
    try { ids = selectionIds(JSON.parse(field("ids"))); } catch { throw new ImportError("Select at most 50 distinct supplier product IDs."); }
    const hasPricing = intent !== "save-selection";
    const markup = hasPricing ? markupPercent(field("markup")) : undefined;
    let markups: MarkupOverrides | undefined;
    if (hasPricing) {
      try { markups = markupOverrides(JSON.parse(field("markups", 5000)), ids); }
      catch (error) {
        if (error instanceof PricingError) throw error;
        throw new ImportError("Invalid per-product markup overrides.");
      }
    }
    if (intent === "preview") {
      const job = await createPreview(session.shop, markup!, async (query, variables) => {
        const response = await admin.graphql(query, { variables, tries: 1 });
        return response.json();
      }, importChoices(form), { ids, markups: markups! });
      return redirect(destination(job.id));
    }
    await validateSelection(ids);
    const pricing = hasPricing ? { markup, markups: JSON.stringify(markups) } : { markups: "{}" };
    await db.catalogSelection.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, productIds: JSON.stringify(ids), ...pricing },
      update: { productIds: JSON.stringify(ids), ...pricing },
    });
    return data({ error: null, saved: true });
  } catch (error) {
    if (!(error instanceof ImportError) && !(error instanceof CatalogError) && !(error instanceof PricingError)) throw error;
    console.warn("Catalog/import request rejected.", error.message);
    return data({ error: error.message, saved: false }, { status: error instanceof CatalogError ? 502 : 400 });
  }
};

function stockLabel(product: { type: string; manage_stock: boolean; stock_quantity: number | null; stock_owner_id: number | null; id: number }) {
  if (product.type === "variable") return "Review stock per variant";
  if (!product.manage_stock) return "Unmanaged stock — review required";
  if (product.stock_quantity === null || product.stock_owner_id !== product.id) return "Unknown/shared stock — review required";
  return product.stock_quantity > 0 ? `${product.stock_quantity} supplier units` : "Out of stock";
}

export default function Index() {
  const { shop, selected, markup: savedMarkup, markups: savedMarkups, filters, products, categories, error, job, history } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const configurationForm = useRef<HTMLFormElement>(null);
  const location = useLocation();
  const [ids, setIds] = useState(selected);
  const [markup, setMarkup] = useState(savedMarkup);
  const [markups, setMarkups] = useState<MarkupOverrides>(savedMarkups);
  const busy = navigation.state !== "idle";
  const dirty = pricingSignature(ids, markup, markups) !== pricingSignature(selected, savedMarkup, savedMarkups);
  useBeforeUnload(useCallback((event) => {
    if (dirty) { event.preventDefault(); event.returnValue = ""; }
  }, [dirty]));
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const params = new URLSearchParams(location.search);
  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key); else next.set(key, value);
    }
    return `/app?${next}`;
  };
  const pageIds = products?.products.map((product) => product.id) || [];
  const selectedOnPage = pageIds.filter((id) => ids.includes(id)).length;
  const allOnPageSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const pageExceedsLimit = ids.length + pageIds.length - selectedOnPage > 50;
  const offPage = ids.filter((id) => !pageIds.includes(id));
  const select = (nextIds: number[]) => {
    setIds(nextIds);
    setMarkups((current) => selectedOverrides(current, nextIds));
  };
  const overrideField = (id: number, name: string) => <label>Markup override for {name} (%)
    <input type="number" min="0" max="1000" step="0.01" inputMode="decimal" autoComplete="off"
      aria-describedby="markup-help" value={markups[id] ?? ""} disabled={busy || !ids.includes(id)}
      placeholder={`Default: ${markup || "0"}%`}
      onChange={(event) => {
        const value = event.currentTarget.value;
        setMarkups((current) => {
          const next = { ...current };
          if (value === "") delete next[id]; else next[id] = value;
          return next;
        });
      }} />
  </label>;

  return <s-page heading="UltraLove catalog and imports">
    <s-section heading="Select products and set retail markup">
      <s-paragraph>Test store: {shop}. Select up to 50 parent products. Each parent’s markup applies to all its published variants.</s-paragraph>
      <s-paragraph>All prices are CAD. Saving and previewing do not import, publish, sync inventory or approve order forwarding.</s-paragraph>
      <div className="catalog-browser">
        <p><Link to="/app/inventory">Manage inventory sync</Link></p>
        {blocker.state === "blocked" && <s-banner heading="Unsaved selection or markup" tone="warning">
          Stay to save your changes, or leave without saving.
          <s-button onClick={() => blocker.reset()}>Stay on this page</s-button>
          <s-button onClick={() => blocker.proceed()}>Leave without saving</s-button>
        </s-banner>}
        {error && <div role="alert"><s-banner heading="Catalog unavailable" tone="critical">{error} <Link to={href({})}>Retry catalog</Link></s-banner></div>}
        {result?.error && <div role="alert"><s-banner heading="Action could not be completed" tone="critical">{result.error}</s-banner></div>}
        <Form method="get" className="catalog-filters">
          {["shop", "host", "embedded", "job"].filter((key) => params.has(key)).map((key) => <input key={key} type="hidden" name={key} value={params.get(key)!} />)}
          <label>Search name or SKU <input name="search" defaultValue={filters.search || ""} key={filters.search || ""} maxLength={100} autoComplete="off" /></label>
          <label>Category
            <select name="category_id" defaultValue={filters.category_id || 0} key={`${filters.category_id}-${filters.categoryAfter}`}>
              <option value="0">All categories</option>
              {filters.category_id && !categories?.categories.some((category) => category.id === filters.category_id) && <option value={filters.category_id}>Selected category #{filters.category_id}</option>}
              {categories?.categories.map((category) => <option key={category.id} value={category.id}>{supplierText(category.name)}</option>)}
            </select>
          </label>
          <s-button type="submit" disabled={busy} loading={busy && navigation.formMethod === "GET"}>Search catalog</s-button>
          {(filters.search || filters.category_id) && <Link to={href({ search: null, category_id: null, after_id: null })}>Clear filters</Link>}
        </Form>
        {categories?.has_more && <p><Link to={href({ category_after: String(categories.next_after_id) })}>More categories</Link></p>}
        <Form method="post" ref={configurationForm}>
          <input type="hidden" name="intent" value="preview" />
          <input type="hidden" name="ids" value={JSON.stringify(ids)} />
          <input type="hidden" name="markups" value={JSON.stringify(selectedOverrides(markups, ids))} />
          <div className="catalog-pricing-controls">
            <label>Default retail markup (%)
              <input name="markup" type="number" min="0" max="1000" step="0.01" inputMode="decimal" required autoComplete="off"
                value={markup} disabled={busy} aria-describedby="markup-help" onChange={(event) => setMarkup(event.currentTarget.value)} />
            </label>
            <s-button type="button" disabled={busy || !Object.keys(markups).length}
              onClick={() => setMarkups({})}>Apply default to all selected products</s-button>
            <s-button type="button" disabled={busy || !dirty} onClick={() => {
              setIds(selected); setMarkup(savedMarkup); setMarkups(savedMarkups);
            }}>Reset to saved selection and markup</s-button>
          </div>
          <p id="markup-help">Default markup applies unless a product has an override. Changing the default keeps overrides.
            Leave an override blank to use the default. Apply default to all removes every override, including off-page products.
            Use 0–1000%, with at most two decimals. Retail = supplier price × (1 + markup / 100), rounded to two decimals; no shipping, taxes, fees or FX are added.</p>
          <div role="status" aria-live="polite">
            <p>{ids.length} of 50 selected; {offPage.length} on other pages. {Object.keys(markups).length} markup overrides.
              {" "}{dirty ? "Unsaved selection or markup." : "Selection and markup saved."}
              {" "}No import runs until you confirm and queue it.</p>
          </div>
          {pageExceedsLimit && <p id="page-selection-limit">Selecting all on this page would exceed 50 products. Remove some selections or select individually.</p>}
          {/* Keyboard users need focus on the horizontally scrollable table region. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <div className="catalog-table" tabIndex={0} role="region" aria-label="Supplier catalog">
            <table>
              <caption>Supplier products — wholesale CAD prices, not Shopify selling prices. The preview below shows exact variant retail prices.</caption>
              <thead><tr><th scope="col"><label><span><input type="checkbox" checked={allOnPageSelected}
                ref={(input) => { if (input) input.indeterminate = selectedOnPage > 0 && !allOnPageSelected; }}
                disabled={busy || !pageIds.length || (!allOnPageSelected && pageExceedsLimit)}
                aria-describedby={pageExceedsLimit ? "page-selection-limit" : undefined}
                onChange={(event) => select(pageSelection(ids, pageIds, event.currentTarget.checked))} /> Select all on this page</span></label></th>
                <th scope="col">Image</th><th scope="col">Product</th><th scope="col">SKU</th><th scope="col">Wholesale</th><th scope="col">Retail markup</th><th scope="col">Availability</th></tr></thead>
              <tbody>{products?.products.map((product) => <tr key={product.id}>
                <td><label><span><input type="checkbox" aria-label={`Select ${supplierText(product.name)} (#${product.id})`} checked={ids.includes(product.id)}
                  disabled={busy || (!ids.includes(product.id) && ids.length >= 50)}
                  onChange={(event) => select(event.currentTarget.checked ? [...ids, product.id] : ids.filter((id) => id !== product.id))} /></span></label></td>
                <td><ProductImage image={product.images[0]} name={product.name} /></td>
                <td>{supplierText(product.name)}<small>#{product.id} — {product.type}</small></td>
                <td>{product.sku || "Missing SKU — review required"}</td>
                <td>{product.price === null || product.price === "" ? "Missing price — review required" : `${product.price} CAD`}</td>
                <td>{overrideField(product.id, supplierText(product.name))}</td><td>{stockLabel(product)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          {products && !products.products.length && <s-paragraph>No products match these filters. Clear filters or try another name or SKU; your selections remain available below.</s-paragraph>}
          {offPage.length > 0 && <fieldset className="catalog-off-page">
            <legend>Selected products on other pages</legend>
            <div className="catalog-selected-products">{offPage.map((id) => <div key={id}>
              {overrideField(id, `product #${id}`)}
              <s-button type="button" disabled={busy} onClick={() => select(ids.filter((selectedId) => selectedId !== id))}>Remove product #{id}</s-button>
            </div>)}</div>
          </fieldset>}
          <p>Selected IDs: {ids.length ? ids.join(", ") : "None"}</p>
          <s-button type="button" disabled={busy || !ids.length} onClick={() => select([])}>Clear working selection</s-button>
          <ImportOptions disabled={busy} />
          <div className="catalog-actions">
            <s-button type="button" disabled={busy || Boolean(error)} onClick={() => {
              if (!configurationForm.current?.reportValidity()) return;
              const form = new FormData(configurationForm.current);
              form.set("intent", "save-configuration");
              submit(form, { method: "post" });
            }} loading={busy && navigation.formData?.get("intent") === "save-configuration"}>Save selection and markup</s-button>
            <s-button type="submit" variant="primary" disabled={busy || !ids.length || Boolean(error)}
              loading={busy && navigation.formData?.get("intent") === "preview"}>Preview import</s-button>
          </div>
          <p>Preview import saves your selection and markup and creates a fixed snapshot, valid for 10 minutes. It does not queue an import.
            Visibility switches apply to the next preview, not an existing snapshot.</p>
        </Form>
        <p><Link to={href({ after_id: null })}>First product page</Link>{products?.has_more && <> | <Link to={href({ after_id: String(products.next_after_id) })}>Next 50 products</Link></>}</p>
      </div>
    </s-section>
    <div className="catalog-browser">
      <ImportResults job={job} history={history} ids={ids} markup={markup} markups={markups} busy={busy} jobHref={(id) => href({ job: id })} />
    </div>
  </s-page>;
}

export function ErrorBoundary() { return boundary.error(useRouteError()); }
export const headers: HeadersFunction = (args) => boundary.headers(args);
