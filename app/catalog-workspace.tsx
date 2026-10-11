import { useCallback, useEffect, useRef } from "react";
import { Form, Link, useActionData, useFetcher, useLoaderData, useLocation, useNavigation, useSubmit } from "react-router";
import type { action, loader } from "./routes/app._index";
import type { loader as detailsLoader } from "./routes/app.selection-details";
import { CATALOG_BATCH_SIZE, pageSelection, supplierText } from "./catalog-policy";
import { pricingSignature, retailPrice, selectedOverrides } from "./pricing-policy";
import { useWorkspace, WorkspaceNav } from "./workspace";
import { selectedPage, validListingChoices, validPricing, workspaceHref } from "./workspace-policy";
import ProductImage from "./product-image";
import ImportOptions from "./import-options";
import ImportResults from "./import-results";
import ListingOptions from "./listing-options";
import "./catalog.css";

function stockLabel(product: { type: string; manage_stock: boolean; stock_quantity: number | null; stock_owner_id: number | null; id: number }) {
  if (product.type === "variable") return "Stock varies by variant";
  if (!product.manage_stock) return "Unmanaged · needs review";
  if (product.stock_quantity === null || product.stock_owner_id !== product.id) return "Unknown/shared · needs review";
  return product.stock_quantity > 0 ? `${product.stock_quantity} units` : "Out of stock";
}

export default function CatalogWorkspace() {
  const { selected, markup: savedMarkup, markups: savedMarkups, filters, products, categories, error, job, history } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const configurationForm = useRef<HTMLFormElement>(null);
  const location = useLocation();
  const { draft, setDraft, storageAvailable } = useWorkspace();
  const { selected: ids, markup, markups } = draft;
  const busy = navigation.state !== "idle";
  const baseline = pricingSignature(selected, savedMarkup, savedMarkups);
  const dirty = pricingSignature(ids, markup, markups) !== baseline;
  const params = new URLSearchParams(location.search);
  const requestedView = params.get("view") || (job ? "review" : "catalog");
  const view = ["catalog", "selection", "review", "imports"].includes(requestedView) ? requestedView : "catalog";
  const heading = useRef<HTMLHeadingElement>(null);
  const previousView = useRef(view);
  const details = useFetcher<typeof detailsLoader>();
  const fetchDetails = details.load;
  const detailsPending = useRef(false);
  const missingDetails = ids.filter((id) => !draft.products[id]);
  const selection = selectedPage(ids, draft.products, draft.selectionSearch, draft.selectionPage);
  const loadDetails = useCallback(() => {
    const missing = draft.selected.filter((id) => !draft.products[id]).slice(0, CATALOG_BATCH_SIZE);
    if (!missing.length) return;
    const query = new URLSearchParams();
    const context = new URLSearchParams(location.search);
    for (const key of ["shop", "host", "embedded", "id_token"]) {
      const value = context.get(key);
      if (value) query.set(key, value);
    }
    query.set("ids", JSON.stringify(missing));
    detailsPending.current = true;
    void fetchDetails(`/app/selection-details?${query}`);
  }, [draft.selected, draft.products, location.search, fetchDetails]);
  useEffect(() => {
    if (details.state !== "idle") return;
    if (detailsPending.current) {
      const response = details.data;
      if (!response) return;
      detailsPending.current = false;
      if (response.error) return;
      setDraft((current) => ({ ...current, products: { ...current.products,
        ...Object.fromEntries(response.products.map((product) => [product.id, product])) } }));
      return;
    }
    if (view === "selection" && !details.data?.error) loadDetails();
  }, [details.state, details.data, view, loadDetails, setDraft]);
  useEffect(() => {
    setDraft((current) => {
      const known = { ...current.products };
      for (const product of products?.products || []) known[product.id] = {
        id: product.id, name: product.name, sku: product.sku, price: product.price, type: product.type,
      };
      for (const item of job?.items || []) {
        if (!known[item.supplierId]) known[item.supplierId] = {
          id: item.supplierId, name: item.name, sku: item.sku, price: null, type: item.variantCount > 1 ? "variable" : "simple",
        };
      }
      const browse = new URLSearchParams();
      for (const key of ["search", "category_id", "after_id", "category_after"]) {
        const value = new URLSearchParams(location.search).get(key);
        if (value) browse.set(key, value);
      }
      return { ...current, products: known, baseline,
        browse: view === "catalog" || view === "selection" ? browse.toString() : current.browse };
    });
  }, [products, job, location.search, view, baseline, setDraft]);
  useEffect(() => {
    if (previousView.current !== view) heading.current?.focus();
    previousView.current = view;
  }, [view]);
  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key); else next.set(key, value);
    }
    return `/app?${next}`;
  };
  const viewHref = (next: string, jobId?: string) => workspaceHref(location.search, next, draft.browse, jobId);
  const pageIds = products?.products.map((product) => product.id) || [];
  const selectedOnPage = pageIds.filter((id) => ids.includes(id)).length;
  const allOnPageSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const offPage = ids.filter((id) => !pageIds.includes(id));
  const select = (nextIds: number[]) => setDraft((current) => ({
    ...current, selected: nextIds, markups: selectedOverrides(current.markups, nextIds),
    selectionPage: selectedPage(nextIds, current.products, current.selectionSearch, current.selectionPage).page,
    listingPolicy: { ...current.listingPolicy,
      links: Object.fromEntries(Object.entries(current.listingPolicy.links).filter(([id]) => nextIds.includes(Number(id)))),
      recreate: current.listingPolicy.recreate.filter((id) => nextIds.includes(id)) },
  }));
  const overrideField = (id: number, name: string) => <label><span>Markup (%)</span>
    <input type="number" min="0" max="1000" step="0.01" inputMode="decimal" autoComplete="off"
      aria-label={`Markup override for ${name} (%)`} aria-describedby="markup-help"
      value={markups[id] ?? ""} disabled={busy} placeholder={`Default: ${markup}%`}
      onChange={(event) => {
        const value = event.currentTarget.value;
        setDraft((current) => {
          const next = { ...current.markups };
          if (value === "") delete next[id]; else next[id] = value;
          return { ...current, markups: next };
        });
      }} />
  </label>;
  const estimate = (price: string | null, id: number, type: string) => {
    if (!price || type === "variable") return "Exact prices in preview";
    try { return `$${retailPrice(price, markups[id] ?? markup)}`; } catch { return "Check markup"; }
  };
  const names = { catalog: "UltraLove's catalog", selection: "Selection & pricing", review: "Review import", imports: "Imports" };
  const save = () => {
    if (!configurationForm.current) return;
    const form = new FormData(configurationForm.current);
    form.set("intent", "save-configuration");
    submit(form, { method: "post" });
  };
  return <s-page heading="UltraLove" inlineSize="large">
    <div className="catalog-browser workspace">
      <WorkspaceNav current={view} />
      <header className="workspace-header">
        <div><h1 ref={heading} tabIndex={-1}>{names[view as keyof typeof names]}</h1>
          <p>{view === "catalog" ? "Find products to add to your store. Review pricing before anything is imported." :
            view === "selection" ? "Set your selling prices and remove anything you don't want to import." :
              view === "review" ? "Review prices and any requested product updates. Nothing changes until you confirm." :
                "Track imports, review products, or safely retry unfinished items."}</p></div>
        {view === "imports" && <Link className="workspace-primary" to={viewHref("catalog")}>Browse catalog</Link>}
      </header>
      {!storageAvailable && <s-banner heading="Browser draft storage unavailable" tone="warning">Your working changes remain while navigating this app, but save before reloading or closing this tab.</s-banner>}
      {error && <div role="alert"><s-banner heading="Catalog unavailable" tone="critical">{error} <Link to={href({})}>Retry catalog</Link></s-banner></div>}
      {result?.error && <div role="alert"><s-banner heading="Action could not be completed" tone="critical">{result.error}</s-banner></div>}
      {(view === "catalog" || view === "selection") && <Form method="post" ref={configurationForm} id="configuration-form">
        <input type="hidden" name="intent" value="preview" />
        <input type="hidden" name="ids" value={JSON.stringify(ids)} />
        <input type="hidden" name="markups" value={JSON.stringify(selectedOverrides(markups, ids))} />
        <input type="hidden" name="markup" value={markup} />
        <input type="hidden" name="listing-policy" value={JSON.stringify(draft.listingPolicy)} />
        {draft.active && <input type="hidden" name="active" value="yes" />}
        {draft.publish && <input type="hidden" name="publish" value="yes" />}
      </Form>}
      {view === "catalog" && <section className="workspace-panel" aria-label="Browse supplier products">
        <Form method="get" className="catalog-filters" role="search">
          {["shop", "host", "embedded"].filter((key) => params.has(key)).map((key) => <input key={key} type="hidden" name={key} value={params.get(key)!} />)}
          <input type="hidden" name="view" value="catalog" />
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
        <div className="catalog-toolbar"><span>{products?.products.length ?? 0} products on this page · CAD</span>
          <Link to={viewHref("selection")}>Retail estimates at {markup}% default markup</Link>
          {categories?.has_more && <Link to={href({ category_after: String(categories.next_after_id) })}>More categories</Link>}</div>
        {/* A focusable region lets keyboard users scroll wide catalog tables. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div className="catalog-table" tabIndex={0} role="region" aria-label="UltraLove's catalog">
          <table>
            <caption className="visually-hidden">UltraLove products with wholesale prices and estimated retail prices in CAD. Availability is UltraLove stock, not Shopify inventory.</caption>
            <thead><tr><th scope="col"><span className="checkbox-label"><input type="checkbox" aria-label="Select all on this page" checked={allOnPageSelected}
              ref={(input) => { if (input) input.indeterminate = selectedOnPage > 0 && !allOnPageSelected; }}
              disabled={busy || !pageIds.length}
              onChange={(event) => select(pageSelection(ids, pageIds, event.currentTarget.checked))} /></span></th>
              <th scope="col">Product</th><th scope="col">Wholesale</th><th scope="col">Est. retail</th><th scope="col">Availability</th></tr></thead>
            <tbody>{products?.products.map((product) => <tr key={product.id} className={ids.includes(product.id) ? "is-selected" : undefined}>
              <td><input type="checkbox" aria-label={`Select ${supplierText(product.name)} (#${product.id})`} checked={ids.includes(product.id)}
                disabled={busy}
                onChange={(event) => select(event.currentTarget.checked ? [...ids, product.id] : ids.filter((id) => id !== product.id))} /></td>
              <td><div className="catalog-product"><ProductImage image={product.images[0]} name={product.name} />
                <div><strong>{supplierText(product.name)}</strong><small>{product.sku || "Missing SKU — review required"} · {product.type === "variable" ? "Multiple variants" : "Single variant"}</small></div></div></td>
              <td>{product.price === null || product.price === "" ? "Price needs review" : `$${product.price}`}</td>
              <td><strong>{estimate(product.price, product.id, product.type)}</strong>{markups[product.id] !== undefined && <small>{markups[product.id]}% override</small>}</td>
              <td>{stockLabel(product)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {products && !products.products.length && <div className="workspace-empty"><h2>No matching products</h2><p>Try another name or SKU. Your selections have not changed.</p><Link to={href({ search: null, category_id: null, after_id: null })}>Clear filters</Link></div>}
        <nav className="catalog-pagination" aria-label="Catalog pages"><Link to={href({ after_id: null })}>First page</Link>
          {products?.has_more && <Link to={href({ after_id: String(products.next_after_id) })}>Next 50 products</Link>}</nav>
      </section>}
      {view === "selection" && <div className="selection-layout">
        <section className="workspace-panel selection-list" aria-labelledby="selected-heading">
          <div className="catalog-toolbar"><h2 id="selected-heading">{ids.length} selected products</h2>
            <s-button disabled={busy || !ids.length} onClick={() => select([])}>Remove all selected</s-button></div>
          {!!ids.length && <div className="catalog-filters" role="search" aria-label="Search selected products">
            <label>Search selected products
              <input type="search" maxLength={100} placeholder="Product name, SKU or ID" value={draft.selectionSearch}
                onChange={(event) => {
                  const selectionSearch = event.currentTarget.value;
                  setDraft((current) => ({ ...current, selectionSearch, selectionPage: 1 }));
                }} />
            </label>
            <s-button disabled={!draft.selectionSearch} onClick={() => setDraft((current) => ({ ...current, selectionSearch: "", selectionPage: 1 }))}>Clear search</s-button>
          </div>}
          {!!missingDetails.length && <p role="status">{details.data?.error
            ? `${missingDetails.length} products still need details. Search currently matches known names/SKUs and all selected IDs.`
            : `Loading details for ${missingDetails.length} selected products. Name and SKU results may be incomplete until loading finishes.`}</p>}
          {!!missingDetails.length && details.data?.error && <div role="alert"><s-banner heading="Selected product details unavailable" tone="warning">
            {details.data.error} Your selections and pricing edits are unchanged.
            <s-button disabled={details.state !== "idle" || !missingDetails.length} onClick={loadDetails}>Retry details</s-button>
          </s-banner></div>}
          {!ids.length ? <div className="workspace-empty"><h2>Start with a few products</h2><p>Select products in the catalog, then return here to set pricing.</p><Link to={viewHref("catalog")}>Browse catalog</Link></div> :
            <><p role="status">Showing {selection.start}–{selection.end} of {selection.total} {draft.selectionSearch.trim() ? `matching products (${ids.length} selected in total)` : "selected products"}</p>
            {!selection.total && <div className="workspace-empty"><h3>No matching selected products</h3><p>Try a different name, SKU or product ID, or clear the search.</p></div>}
            <ul className="selection-products">{selection.ids.map((id) => {
              const product = draft.products[id];
              const name = product ? supplierText(product.name) : `Supplier product #${id}`;
              return <li key={id}>
                <div className="selection-product-name"><strong>{name}</strong><small>{product?.sku || "Details verified in preview"}{offPage.includes(id) ? " · Outside current catalog page" : ""}</small></div>
                <div className="selection-price"><small>Est. retail · CAD</small><strong>{estimate(product?.price ?? null, id, product?.type ?? "")}</strong></div>
                {overrideField(id, name)}
                <button type="button" className="quiet-button" disabled={busy} aria-label={`Remove ${name}`} onClick={() => select(ids.filter((selectedId) => selectedId !== id))}>Remove</button>
              </li>;
            })}</ul>
            <nav className="catalog-pagination" aria-label="Selected products pagination">
              <s-button disabled={selection.page === 1} onClick={() => setDraft((current) => ({ ...current, selectionPage: selection.page - 1 }))}>Previous</s-button>
              <span>Page {selection.page} of {selection.pages}</span>
              <s-button disabled={selection.page === selection.pages} onClick={() => setDraft((current) => ({ ...current, selectionPage: selection.page + 1 }))}>Next</s-button>
            </nav></>}
          <Link to={viewHref("catalog")}>Add more products</Link>
        </section>
        <aside className="workspace-panel pricing-panel" aria-labelledby="pricing-heading">
          <h2 id="pricing-heading">Pricing defaults</h2>
          <label>Default retail markup (%)
            <input type="number" min="0" max="1000" step="0.01" inputMode="decimal" required autoComplete="off"
              value={markup} disabled={busy} aria-describedby="markup-help" onChange={(event) => {
                const value = event.currentTarget.value;
                setDraft((current) => ({ ...current, markup: value }));
              }} />
          </label>
          <p id="markup-help">Applies to every selected product unless it has an override. Leave overrides blank to use the default.</p>
          {!validPricing(draft) && <p role="alert">Use 0–1000%, with at most two decimal places, for the default and every override.</p>}
          <s-button disabled={busy || !Object.keys(markups).length} onClick={() => setDraft((current) => ({ ...current, markups: {} }))}>Use default for all {ids.length} products</s-button>
          <details><summary>How prices are calculated</summary><p>Retail = supplier price × (1 + markup / 100), rounded to two decimals in CAD. Markup is not margin. Shipping, taxes, fees and FX are not included. The preview verifies exact variant prices.</p></details>
          <ImportOptions disabled={busy} active={draft.active} publish={draft.publish}
            onChange={(active, publish) => setDraft((current) => ({ ...current, active, publish }))} />
          <ListingOptions disabled={busy} policy={draft.listingPolicy}
            onChange={(listingPolicy) => setDraft((current) => ({ ...current, listingPolicy }))} />
          <p className="workspace-note">Preview saves this configuration and checks every variant. You confirm separately before importing.</p>
        </aside>
      </div>}
      {(view === "catalog" || view === "selection") && <div className="selection-bar">
        <div role="status" aria-live="polite"><strong>{ids.length} selected</strong><small>{dirty ? "Unsaved to store" : "Saved to store"}{storageAvailable ? " · Draft kept in this tab" : ""}{view === "catalog" && offPage.length ? ` · ${offPage.length} outside this page` : ""}</small></div>
        <div className="catalog-actions">
          <s-button disabled={busy || !dirty} onClick={save} loading={busy && navigation.formData?.get("intent") === "save-configuration"}>Save changes</s-button>
          <details className="selection-reset"><summary>Reset</summary><s-button disabled={busy || !dirty} onClick={() => setDraft((current) => ({ ...current, selected, markup: savedMarkup, markups: savedMarkups }))}>Restore saved selection and markup</s-button></details>
          {view === "catalog" ? <Link className="workspace-primary" to={viewHref("selection")}>Review selection{ids.length ? ` (${ids.length})` : ""}</Link> :
            <s-button variant="primary" disabled={busy || !ids.length || !validPricing(draft) || !validListingChoices(draft)} loading={busy && navigation.formData?.get("intent") === "preview"}
              onClick={() => { if (configurationForm.current) submit(new FormData(configurationForm.current), { method: "post" }); }}>Create pricing preview</s-button>}
        </div>
      </div>}
      {(view === "review" || view === "imports") && <ImportResults job={job} history={history} ids={ids} markup={markup} markups={markups} busy={busy}
        listingPolicy={draft.listingPolicy} activeChoice={draft.active} publishChoice={draft.publish} mode={view} jobHref={(id) => viewHref("imports", id)} selectionHref={viewHref("selection")} catalogHref={viewHref("catalog")}
        onRecoveryPreview={() => { if (job) setDraft((current) => ({ ...current, selected: job.items.map((item) => item.supplierId),
          markup: job.markup, markups: job.markups, listingPolicy: job.listingPolicy, active: job.active, publish: Boolean(job.publicationId) })); }}
        inventoryHref={viewHref("inventory")} />}
    </div>
  </s-page>;
}
