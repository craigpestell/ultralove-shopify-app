import { useCallback, useEffect, useRef, useState } from "react";
import { Form, useActionData, useFetcher, useLoaderData, useLocation, useSubmit } from "react-router";
import type { action, loader } from "./routes/app._index";
import type { loader as detailsLoader } from "./routes/app.selection-details";
import { CATALOG_BATCH_SIZE, pageSelection, supplierText } from "./catalog-policy";
import { retailPrice, selectedOverrides } from "./pricing-policy";
import { useWorkspace, WorkspaceNav } from "./workspace";
import { selectedPage, signature, validListingChoices, validPricing, workspaceHref } from "./workspace-policy";
import { fulfillmentLabel, fulfillmentMode, modeFor } from "./fulfillment-policy";
import ProductImage from "./product-image";
import ImportOptions from "./import-options";
import ImportResults from "./import-results";
import ListingOptions from "./listing-options";
import { PendingLink, RequestFeedback, useNetworkState } from "./network-state";
import "./catalog.css";

function stockLabel(product: { type: string; manage_stock: boolean; stock_quantity: number | null; stock_owner_id: number | null; id: number }) {
  if (product.type === "variable") return "Stock varies by variant";
  if (!product.manage_stock) return "Unmanaged · needs review";
  if (product.stock_quantity === null || product.stock_owner_id !== product.id) return "Unknown/shared · needs review";
  return product.stock_quantity > 0 ? `${product.stock_quantity} units` : "Out of stock";
}

export default function CatalogWorkspace() {
  const { selected, markup: savedMarkup, markups: savedMarkups, fulfillmentModes: savedModes, filters, products, categories, error, job, history } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const submit = useSubmit();
  const configurationForm = useRef<HTMLFormElement>(null);
  const location = useLocation();
  const { draft, setDraft, storageAvailable } = useWorkspace();
  const { selected: ids, markup, markups } = draft;
  const { busy, pending } = useNetworkState();
  const previewing = pending({ intent: "preview" });
  const saving = pending({ intent: "save-configuration" });
  const modes = draft.fulfillmentModes ?? {};
  const baseline = signature({ selected, markup: savedMarkup, markups: savedMarkups, fulfillmentModes: savedModes });
  const dirty = signature(draft) !== baseline;
  const params = new URLSearchParams(location.search);
  const requestedView = params.get("view") || (job ? "review" : "catalog");
  const view = ["catalog", "selection", "review", "imports"].includes(requestedView) ? requestedView : "catalog";
  const heading = useRef<HTMLHeadingElement>(null);
  const previousView = useRef(view);
  // Catalog-only filter: page through the current selection instead of UltraLove's feed.
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [selectedOnlySearch, setSelectedOnlySearch] = useState("");
  const [selectedOnlyPage, setSelectedOnlyPage] = useState(1);
  const [removed, setRemoved] = useState<{ ids: number[]; label: string } | null>(null);
  const showSelected = view === "catalog" && selectedOnly;
  const details = useFetcher<typeof detailsLoader>();
  const fetchDetails = details.load;
  const detailsPending = useRef(false);
  const missingDetails = ids.filter((id) => !draft.products[id]);
  const selection = selectedPage(ids, draft.products, draft.selectionSearch, draft.selectionPage);
  const selectedRows = selectedPage(ids, draft.products, selectedOnlySearch, selectedOnlyPage);
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
    if ((view === "selection" || showSelected) && !details.data?.error) loadDetails();
  }, [details.state, details.data, view, showSelected, loadDetails, setDraft]);
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
  const pageIds = showSelected ? selectedRows.ids : products?.products.map((product) => product.id) || [];
  const selectedOnPage = pageIds.filter((id) => ids.includes(id)).length;
  const allOnPageSelected = pageIds.length > 0 && selectedOnPage === pageIds.length;
  const offPage = ids.filter((id) => !pageIds.includes(id));
  const select = (nextIds: number[]) => setDraft((current) => ({
    ...current, selected: nextIds, markups: selectedOverrides(current.markups, nextIds),
    fulfillmentModes: Object.fromEntries(Object.entries(current.fulfillmentModes ?? {}).filter(([id]) => nextIds.includes(Number(id)))),
    selectionPage: selectedPage(nextIds, current.products, current.selectionSearch, current.selectionPage).page,
    listingPolicy: { ...current.listingPolicy,
      links: Object.fromEntries(Object.entries(current.listingPolicy.links).filter(([id]) => nextIds.includes(Number(id)))),
      recreate: current.listingPolicy.recreate.filter((id) => nextIds.includes(id)) },
  }));
  // Unselecting from the selected-only list hides the row, so keep one step of undo.
  const unselect = (removedIds: number[], label: string) => {
    if (!removedIds.length) return;
    select(ids.filter((id) => !removedIds.includes(id)));
    setRemoved({ ids: removedIds, label });
  };
  const undoRemove = () => {
    if (!removed) return;
    select([...ids, ...removed.ids.filter((id) => !ids.includes(id))]);
    setRemoved(null);
  };
  const showProducts = (only: boolean) => {
    setSelectedOnly(only);
    setRemoved(null);
    setSelectedOnlyPage(1);
  };
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
  return <s-page heading="UltraLove Catalog" inlineSize="large">
    <div className="catalog-browser workspace">
      <WorkspaceNav current={view} />
      <header className="workspace-header">
        <div><h1 ref={heading} tabIndex={-1}>{names[view as keyof typeof names]}</h1>
          <p>{view === "catalog" ? "Find products to add to your store. Review pricing before anything is imported." :
            view === "selection" ? "Set your selling prices and remove anything you don't want to import." :
              view === "review" ? "Review prices and any requested product updates. Nothing changes until you confirm." :
                "Track imports, review products, or safely retry unfinished items."}</p></div>
        {view === "imports" && <PendingLink className="workspace-primary" to={viewHref("catalog")}>Browse catalog</PendingLink>}
      </header>
      {!storageAvailable && <s-banner heading="Browser draft storage unavailable" tone="warning">Your working changes remain while navigating this app, but save before reloading or closing this tab.</s-banner>}
      <RequestFeedback error={error} errorHeading="Catalog unavailable"><PendingLink to={href({})}>Retry catalog</PendingLink></RequestFeedback>
      <RequestFeedback pending={previewing || saving}
        pendingMessage={previewing ? "Saving your configuration and checking every variant. Large selections can take a moment." : "Saving your selection and pricing to the store."}
        error={result?.error} success={result && "saved" in result && result.saved && !dirty ? "Selection and pricing saved to your store." : undefined} />
      {(view === "catalog" || view === "selection") && <Form method="post" ref={configurationForm} id="configuration-form">
        <input type="hidden" name="intent" value="preview" />
        <input type="hidden" name="ids" value={JSON.stringify(ids)} />
        <input type="hidden" name="markups" value={JSON.stringify(selectedOverrides(markups, ids))} />
        <input type="hidden" name="markup" value={markup} />
        <input type="hidden" name="fulfillment-modes" value={JSON.stringify(modes)} />
        <input type="hidden" name="listing-policy" value={JSON.stringify(draft.listingPolicy)} />
        {draft.active && <input type="hidden" name="active" value="yes" />}
        {draft.publish && <input type="hidden" name="publish" value="yes" />}
      </Form>}
      {view === "catalog" && <section className="workspace-panel" aria-label="Browse supplier products">
        <div className="catalog-show" role="group" aria-label="Show products">
          <button type="button" aria-pressed={!selectedOnly} onClick={() => showProducts(false)}>All products</button>
          <button type="button" aria-pressed={selectedOnly} onClick={() => showProducts(true)}>Selected only ({ids.length})</button>
        </div>
        {showSelected ? <>
          {!!ids.length && <div className="catalog-filters" role="search" aria-label="Search selected products">
            <label>Search selected products
              <input type="search" maxLength={100} placeholder="Product name, SKU or ID" value={selectedOnlySearch} autoComplete="off"
                onChange={(event) => { setSelectedOnlySearch(event.currentTarget.value); setSelectedOnlyPage(1); }} />
            </label>
            <s-button disabled={!selectedOnlySearch} onClick={() => { setSelectedOnlySearch(""); setSelectedOnlyPage(1); }}>Clear search</s-button>
            <s-button tone="critical" disabled={busy || !ids.length} onClick={() => unselect(ids, `${ids.length} products`)}>Unselect all {ids.length}</s-button>
          </div>}
          {removed && <div role="status" className="catalog-undo">
            <span>Unselected {removed.label}.</span>
            <s-button disabled={busy} onClick={undoRemove}>Undo</s-button>
          </div>}
          {!!missingDetails.length && <p role="status">{details.data?.error
            ? `${missingDetails.length} selected products are missing details. They are listed by ID.`
            : `Loading details for ${missingDetails.length} selected products.`}</p>}
          {!!missingDetails.length && details.data?.error && <div role="alert"><s-banner heading="Selected product details unavailable" tone="warning">
            {details.data.error} Your selections are unchanged.
            <s-button disabled={details.state !== "idle"} onClick={loadDetails}>Retry details</s-button>
          </s-banner></div>}
          {!ids.length ? <div className="workspace-empty"><h2>No products selected</h2><p>Select products in the catalog to see them here.</p>
            <s-button onClick={() => showProducts(false)}>Show all products</s-button></div> : <>
            <div className="catalog-toolbar"><span>Showing {selectedRows.start}–{selectedRows.end} of {selectedRows.total} {selectedOnlySearch.trim() ? `matching products (${ids.length} selected)` : "selected products"} · CAD</span></div>
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
            <div className="catalog-table" tabIndex={0} role="region" aria-label="Selected products">
              <table>
                <caption className="visually-hidden">Selected UltraLove products with wholesale prices and estimated retail prices in CAD. Uncheck a product to remove it from your selection.</caption>
                <thead><tr><th scope="col"><span className="checkbox-label"><input type="checkbox" aria-label="Unselect all on this page" checked={pageIds.length > 0}
                  disabled={busy || !pageIds.length} onChange={() => unselect(pageIds, `${pageIds.length} products on this page`)} /></span></th>
                  <th scope="col">Product</th><th scope="col">Wholesale</th><th scope="col">Est. retail</th><th scope="col">Action</th></tr></thead>
                <tbody>{selectedRows.ids.map((id) => {
                  const product = draft.products[id];
                  const name = product ? supplierText(product.name) : `Supplier product #${id}`;
                  return <tr key={id} className="is-selected">
                    <td><input type="checkbox" aria-label={`Unselect ${name} (#${id})`} checked disabled={busy} onChange={() => unselect([id], name)} /></td>
                    <td><div className="catalog-product"><div><strong>{name}</strong><small>{product ? `${product.sku || "Missing SKU — review required"} · ${product.type === "variable" ? "Multiple variants" : "Single variant"}` : "Loading details"}</small></div></div></td>
                    <td>{!product ? "—" : product.price === null || product.price === "" ? "Price needs review" : `$${product.price}`}</td>
                    <td><strong>{estimate(product?.price ?? null, id, product?.type ?? "")}</strong>{markups[id] !== undefined && <small>{markups[id]}% override</small>}</td>
                    <td><button type="button" className="quiet-button" disabled={busy} aria-label={`Unselect ${name}`} onClick={() => unselect([id], name)}>Unselect</button></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            {!selectedRows.total && <div className="workspace-empty"><h2>No matching selected products</h2><p>Try a different name, SKU or product ID, or clear the search.</p></div>}
            {selectedRows.pages > 1 && <nav className="catalog-pagination" aria-label="Selected products pages">
              <s-button disabled={selectedRows.page === 1} onClick={() => setSelectedOnlyPage(selectedRows.page - 1)}>Previous</s-button>
              <span>Page {selectedRows.page} of {selectedRows.pages}</span>
              <s-button disabled={selectedRows.page === selectedRows.pages} onClick={() => setSelectedOnlyPage(selectedRows.page + 1)}>Next</s-button>
            </nav>}
          </>}
        </> : <>
        <Form method="get" className="catalog-filters" role="search">
          {["shop", "host", "embedded"].filter((key) => params.has(key)).map((key) => <input key={key} type="hidden" name={key} value={params.get(key)!} />)}
          <input type="hidden" name="view" value="catalog" />
          <label>Search name or SKU <input name="search" defaultValue={filters.search || ""} key={filters.search || ""} maxLength={100} autoComplete="off" /></label>
          <label>Category
            <select name="category_id" defaultValue={filters.category_id || 0} key={filters.category_id}>
              <option value="0">All categories</option>
              {filters.category_id && !categories?.categories.some((category) => category.id === filters.category_id) && <option value={filters.category_id}>Selected category #{filters.category_id}</option>}
              {categories?.categories.map((category) => <option key={category.id} value={category.id}>{supplierText(category.name)}</option>)}
            </select>
          </label>
          <s-button type="submit" disabled={busy} loading={pending({ method: "GET" })}>Search catalog</s-button>
          {(filters.search || filters.category_id) && <PendingLink to={href({ search: null, category_id: null, after_id: null })}>Clear filters</PendingLink>}
        </Form>
        <div className="catalog-toolbar"><span>{products?.products.length ?? 0} products on this page · CAD</span>
          <PendingLink to={viewHref("selection")}>Retail estimates at {markup}% default markup</PendingLink>
</div>
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
        {products && !products.products.length && <div className="workspace-empty"><h2>No matching products</h2><p>Try another name or SKU. Your selections have not changed.</p><PendingLink to={href({ search: null, category_id: null, after_id: null })}>Clear filters</PendingLink></div>}
        <nav className="catalog-pagination" aria-label="Catalog pages"><PendingLink to={href({ after_id: null })}>First page</PendingLink>
          {products?.has_more && <PendingLink to={href({ after_id: String(products.next_after_id) })}>Next 50 products</PendingLink>}</nav>
        </>}
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
          {!ids.length ? <div className="workspace-empty"><h2>Start with a few products</h2><p>Select products in the catalog, then return here to set pricing.</p><PendingLink to={viewHref("catalog")}>Browse catalog</PendingLink></div> :
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
                <label className="selection-fulfillment">Fulfillment<select aria-label={`Fulfillment for ${name}`} disabled={busy} value={modeFor(modes, id)}
                  onChange={(event) => {
                    const mode = fulfillmentMode(event.currentTarget.value);
                    setDraft((current) => {
                      const next = { ...current.fulfillmentModes };
                      if (mode === "CATALOG") delete next[id]; else next[id] = mode;
                      return { ...current, fulfillmentModes: next };
                    });
                  }}>
                  <option value="CATALOG">{fulfillmentLabel("CATALOG")}</option>
                  <option value="DROPSHIPPING">{fulfillmentLabel("DROPSHIPPING")}</option>
                </select></label>
              </li>;
            })}</ul>
            <nav className="catalog-pagination" aria-label="Selected products pagination">
              <s-button disabled={selection.page === 1} onClick={() => setDraft((current) => ({ ...current, selectionPage: selection.page - 1 }))}>Previous</s-button>
              <span>Page {selection.page} of {selection.pages}</span>
              <s-button disabled={selection.page === selection.pages} onClick={() => setDraft((current) => ({ ...current, selectionPage: selection.page + 1 }))}>Next</s-button>
            </nav></>}
          <PendingLink to={viewHref("catalog")}>Add more products</PendingLink>
        </section>
        <aside className="workspace-panel pricing-panel" aria-labelledby="pricing-heading">
          <fieldset className="catalog-import-options"><legend>How will you fulfill these products?</legend>
            <label>Apply to all {ids.length} selected products
              <select disabled={busy || !ids.length}
                value={ids.every((id) => modeFor(modes, id) === "CATALOG") ? "CATALOG" : ids.every((id) => modeFor(modes, id) === "DROPSHIPPING") ? "DROPSHIPPING" : "MIXED"}
                onChange={(event) => {
                  const mode = fulfillmentMode(event.currentTarget.value);
                  setDraft((current) => ({ ...current, fulfillmentModes: mode === "CATALOG" ? {}
                    : Object.fromEntries(current.selected.map((id) => [id, mode])) }));
                }}>
                <option value="CATALOG">{fulfillmentLabel("CATALOG")}</option>
                <option value="DROPSHIPPING">{fulfillmentLabel("DROPSHIPPING")}</option>
                <option value="MIXED" disabled>Mixed — use each product&apos;s choice</option>
              </select>
            </label>
            <p>Catalog only imports content, not UltraLove quantities. Inventory tracking stays on with no sellable supplier stock; set your own stock in Shopify before publishing.</p>
            <p>Dropshipping imports supplier availability. Inventory sync requires separate opt-in after import. Neither choice approves or enables order forwarding; UltraLove approval and explicit activation remain separate.</p>
          </fieldset>
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
        <div role="status" aria-live="polite"><strong>{ids.length} selected</strong><small>{dirty ? "Unsaved to store" : "Saved to store"}{storageAvailable ? " · Draft kept in this tab" : ""}{view === "catalog" && !showSelected && offPage.length ? ` · ${offPage.length} outside this page` : ""}</small></div>
        <div className="catalog-actions">
          <s-button disabled={busy || !dirty} onClick={save} loading={saving}>Save changes</s-button>
          <details className="selection-reset"><summary>Reset</summary><s-button disabled={busy || !dirty} onClick={() => setDraft((current) => ({ ...current, selected, markup: savedMarkup, markups: savedMarkups, fulfillmentModes: savedModes }))}>Restore saved selection and markup</s-button></details>
          {view === "catalog" ? <PendingLink className="workspace-primary" to={viewHref("selection")} pendingLabel="Loading your selection">Review selection{ids.length ? ` (${ids.length})` : ""}</PendingLink> :
            <s-button variant="primary" disabled={busy || !ids.length || !validPricing(draft) || !validListingChoices(draft)} loading={previewing}
              onClick={() => { if (configurationForm.current) submit(new FormData(configurationForm.current), { method: "post" }); }}>Create pricing preview</s-button>}
        </div>
      </div>}
      {(view === "review" || view === "imports") && <ImportResults job={job} history={history} ids={ids} markup={markup} markups={markups} busy={busy}
        fulfillmentModes={modes}
        listingPolicy={draft.listingPolicy} activeChoice={draft.active} publishChoice={draft.publish} mode={view} jobHref={(id) => viewHref("imports", id)} selectionHref={viewHref("selection")} catalogHref={viewHref("catalog")}
        onRecoveryPreview={() => { if (job) setDraft((current) => ({ ...current, selected: job.items.map((item) => item.supplierId),
          markup: job.markup, markups: job.markups,
          fulfillmentModes: Object.fromEntries(job.items.filter((item) => item.fulfillmentMode === "DROPSHIPPING").map((item) => [item.supplierId, item.fulfillmentMode])),
          listingPolicy: job.listingPolicy, active: job.active, publish: Boolean(job.publicationId) })); }}
        inventoryHref={viewHref("inventory")} />}
    </div>
  </s-page>;
}
