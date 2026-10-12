import { useEffect, useState } from "react";
import { Form, Link, useRevalidator } from "react-router";
import type { importScreen } from "./imports.server";
import { MAX_PREVIEW_AGE } from "./import-engine";
import { supplierText } from "./catalog-policy";
import { pricingSignature } from "./pricing-policy";
import type { MarkupOverrides } from "./pricing-policy";
import { selectedPage, statusLabel } from "./workspace-policy";
import { listingSignature } from "./listing-policy";
import type { ListingPolicy } from "./listing-policy";
import ListingRecovery from "./listing-recovery";
import { fulfillmentLabel, fulfillmentSignature } from "./fulfillment-policy";
import type { FulfillmentModes } from "./fulfillment-policy";

type Screen = Awaited<ReturnType<typeof importScreen>>;
const timestamp = (value: string) => new Date(value).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });

export default function ImportResults({ job, history, ids, markup, markups, fulfillmentModes = {}, listingPolicy, activeChoice, publishChoice, busy, jobHref, mode, selectionHref, catalogHref, inventoryHref, onRecoveryPreview = () => {} }:
  Pick<Screen, "job" | "history"> & {
    ids: number[]; markup: string; markups: MarkupOverrides; busy: boolean; jobHref: (id: string) => string;
    mode: string; selectionHref: string; catalogHref: string; inventoryHref: string;
    listingPolicy: ListingPolicy; activeChoice: boolean; publishChoice: boolean;
    fulfillmentModes?: FulfillmentModes;
    onRecoveryPreview?: () => void;
  }) {
  const revalidator = useRevalidator();
  const [now, setNow] = useState(() => Date.now());
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [browse, setBrowse] = useState({ jobId: job?.id, search: "", page: 1 });
  const search = browse.jobId === job?.id ? browse.search : "";
  const page = browse.jobId === job?.id ? browse.page : 1;
  const active = job?.status === "QUEUED" || job?.status === "RUNNING";
  const freshnessRequired = job?.status === "PREVIEW" || (job?.status === "FAILED" &&
    job.items.some((item) => item.status === "FAILED" && ["UPDATE", "LINK"].includes(item.listing.action)));
  useEffect(() => {
    if (!job || (!active && !freshnessRequired)) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (active && revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [active, freshnessRequired, job, revalidator]);
  const expired = freshnessRequired && job && now - Date.parse(job.createdAt) > MAX_PREVIEW_AGE;
  const fieldsSignature = (policy: ListingPolicy) => listingSignature({ ...policy, links: {}, recreate: [] });
  const changed = job?.status === "PREVIEW" && (
    pricingSignature(ids, markup, markups) !== pricingSignature(job.items.map((item) => item.supplierId), job.markup, job.markups) ||
    fieldsSignature(listingPolicy) !== fieldsSignature(job.listingPolicy) ||
    fulfillmentSignature(ids, fulfillmentModes) !== fulfillmentSignature(job.items.map((item) => item.supplierId),
      Object.fromEntries(job.items.filter((item) => item.fulfillmentMode === "DROPSHIPPING").map((item) => [item.supplierId, item.fulfillmentMode]))) ||
    activeChoice !== job.active || publishChoice !== Boolean(job.publicationId));
  const blocked = job?.items.some((item) => item.listing.action === "BLOCKED") ?? false;
  const replacements = job?.items.filter((item) => item.listing.action === "RECREATE").length ?? 0;
  const completed = job?.items.filter((item) => ["CREATED", "REUSED", "UPDATED", "LINKED"].includes(item.status)).length ?? 0;
  const attention = job?.items.filter((item) => item.error || item.warnings.length || item.listing.action === "BLOCKED" ||
    (job.status === "PREVIEW" && item.listing.action === "RECREATE")).length ?? 0;
  const items = job?.items.filter((item) => !attentionOnly || !attention || item.error || item.warnings.length || item.listing.action === "BLOCKED" ||
    (job.status === "PREVIEW" && item.listing.action === "RECREATE")) ?? [];
  const results = selectedPage(items.map((item) => item.supplierId),
    Object.fromEntries(items.map((item) => [item.supplierId, { name: item.name, sku: item.sku }])), search, page);
  const visible = items.filter((item) => results.ids.includes(item.supplierId));

  return <div className="imports-layout">
    {job ? <section className="workspace-panel" aria-labelledby="job-heading">
      <div className="catalog-toolbar"><h2 id="job-heading">{job.status === "PREVIEW" ? "Pricing snapshot" : "Import results"}</h2>
        <Link to={selectionHref}>{job.status === "PREVIEW" ? "Edit selection & pricing" : "Return to selection"}</Link></div>
      <div className={`job-summary ${job.status === "FAILED" ? "needs-attention" : ""}`} role="status" aria-live="polite">
        <strong>{statusLabel(job.status)}</strong>
        <span>{job.status === "PREVIEW" ? `${job.items.length} products to review` : `${completed} of ${job.items.length} products completed`}</span>
        {job.status === "PREVIEW" && <span>Confirm by {timestamp(new Date(Date.parse(job.createdAt) + MAX_PREVIEW_AGE).toISOString())}</span>}
      </div>
      <div className="snapshot-facts"><p><small>New product visibility</small><strong>{job.publicationId ? "Active + Online Store" : job.active ? "Active, not published" : "Unpublished drafts"}</strong></p>
        <p><small>Snapshot default markup</small><strong>{job.markup}%{Object.keys(job.markups).length > 0 ? ` · ${Object.keys(job.markups).length} overrides` : ""}</strong></p>
        <p><small>Existing listings</small><strong>{job.listingPolicy.mode === "UPDATE" ? "Update selected fields" : "Keep unchanged"}</strong></p></div>
      {(expired || changed) && <s-banner heading="Create a fresh preview" tone="warning">
        {expired ? "This pricing preview has expired." : "Your selection, pricing, or import choices have changed."} <Link to={selectionHref}>Return to selection & pricing</Link> to create a new snapshot.
      </s-banner>}
      {job.error && <div role="alert"><s-banner heading="Import needs attention" tone="critical">{job.error}</s-banner></div>}
      {job.status === "COMPLETE" && <s-banner heading="Import completed" tone="success">
        Review each product below. Catalog-only stock is managed by you; supplier sync is available only for dropshipping products and remains opt-in. <Link to={inventoryHref}>Manage inventory</Link> or <Link to={catalogHref}>select more products</Link>.
      </s-banner>}
      {job.status === "PREVIEW" && replacements > 0 && <s-banner heading="Review replacements" tone="warning">
        {replacements} previously linked product{replacements === 1 ? " is" : "s are"} confirmed missing. Confirmation will create replacements with new product and variant IDs, using this snapshot&apos;s prices and new-product visibility. Previous retailer edits and collection membership are not restored.
      </s-banner>}
      {active && <p>Processing in the background. Results refresh automatically; you can leave this view without stopping the import.</p>}
      {blocked && <s-banner heading="Resolve product connections before importing" tone="warning">Reconnect existing listings or pause and reconcile inventory as indicated below, then create a fresh review. Verified missing products are proposed as replacements; nothing changes before confirmation.</s-banner>}
      {(job.status === "PREVIEW" || job.status === "FAILED") && <Form key={`${job.id}:${job.status}`} method="post" className="catalog-confirmation selection-bar">
        <input type="hidden" name="intent" value={job.status === "FAILED" ? "retry" : "queue"} />
        <input type="hidden" name="job" value={job.id} />
        <div><label className="checkbox-label"><span><input name="confirm" type="checkbox" value={job.confirmation} required disabled={busy || expired || changed || blocked} /> I confirm these products, CAD prices, connections, and reviewed changes.
          {job.publicationId ? " Activate and publish new products to Online Store." : job.active ? " Activate new products without publication." : " Create any new products as unpublished drafts."}
          {" "}Apply the reviewed fulfillment modes; do not enable order forwarding.
          {" "}{job.listingPolicy.mode === "UPDATE" ? "Apply only the selected updates to existing listings; preserve their publication and inventory." : "Keep existing product content and prices unchanged."}</span></label>
          <small>Applies to all {job.items.length} products in this snapshot, not just the visible page or search results.</small>
          {replacements > 0 && <small>This confirmation also authorizes the {replacements} reviewed replacement{replacements === 1 ? "" : "s"}.</small>}
          {job.status === "FAILED" && <small>Retries reconcile unfinished items only, using this snapshot. Uncertain creations require review, never blind recreation.</small>}</div>
        <s-button type="submit" variant="primary" disabled={busy || expired || changed || blocked} loading={busy}>
          {job.status === "FAILED" ? "Retry unfinished items" : job.items.some((item) => ["UPDATE", "LINK", "RECREATE"].includes(item.listing.action)) ?
            "Apply reviewed changes" : `Import ${job.items.length} product${job.items.length === 1 ? "" : "s"}`}
        </s-button>
      </Form>}
      <div className="catalog-filters" role="search" aria-label="Search pricing snapshot">
        <label>Search snapshot products
          <input type="search" maxLength={100} placeholder="Product name, SKU or ID" value={search}
            onChange={(event) => setBrowse({ jobId: job.id, search: event.currentTarget.value, page: 1 })} />
        </label>
        <s-button disabled={!search} onClick={() => setBrowse({ jobId: job.id, search: "", page: 1 })}>Clear snapshot search</s-button>
      </div>
      {attention > 0 && <label className="checkbox-label"><span><input type="checkbox" checked={attentionOnly} onChange={(event) => {
        setAttentionOnly(event.currentTarget.checked);
        setBrowse({ jobId: job.id, search, page: 1 });
      }} /> Show only products needing review ({attention})</span></label>}
      <p role="status">Showing {results.start}–{results.end} of {results.total} matching products · {job.items.length} in this snapshot</p>
      {/* A focusable region lets keyboard users scroll exact pricing and results. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className="catalog-table" tabIndex={0} role="region" aria-label="Pricing snapshot and product results">
        <table>
          <caption>Exact variant prices in CAD. This snapshot cannot be edited.</caption>
          <thead><tr><th scope="col">Product</th><th scope="col">Markup</th><th scope="col">Wholesale</th><th scope="col">Retail</th><th scope="col">Result / review</th></tr></thead>
          <tbody>{visible.map((item) => {
            const changesApplied = ["UPDATED", "LINKED"].includes(item.status);
            return <tr key={item.supplierId}>
            <td><strong>{supplierText(item.name)}</strong><small>{item.sku || "Review variant SKUs"} · {item.variantCount} variant(s)</small>
              <small>{fulfillmentLabel(item.fulfillmentMode)}</small>
              {item.fulfillmentMode === "CATALOG" && <small>No supplier quantities imported; supplier sync unavailable.</small>}</td>
            <td>{item.markup}%{job.markups[item.supplierId] !== undefined && <small>Product override</small>}</td>
            <td>{item.wholesale}</td><td><strong>{item.retail}</strong>{item.productId && (job.listingPolicy.mode === "KEEP" || !job.listingPolicy.prices) && ["KEEP", "LINK", "UPDATE"].includes(item.listing.action) && <small>Not applied to existing listing</small>}</td>
            <td><span className="status-badge">{job.status === "PREVIEW" ? ({
              CREATE: "Ready for import", KEEP: "Existing listing kept", UPDATE: "Update selected fields",
              LINK: job.listingPolicy.mode === "UPDATE" ? "Connect and update" : "Connect existing listing",
              RECREATE: "Create replacement", BLOCKED: "Connection needs attention",
            })[item.listing.action] : statusLabel(item.status)}</span>
              {item.productId && <small><a href={`https://admin.shopify.com/store/ultralove-integration-lab/products/${item.productId.split("/").at(-1)}`} target="_blank" rel="noreferrer">Open in Shopify (new tab)</a></small>}
              {item.warnings.length > 0 && <details><summary>Review {item.warnings.length} warning(s)</summary><ul>{item.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
              {item.error && <p role="alert">{item.error}</p>}
              {item.listing.message && <p>{item.listing.message}</p>}
              {!!item.listing.changes.length && <details><summary>{changesApplied
                ? `${item.listing.changes.length} applied change(s)`
                : `Review ${item.listing.changes.length} proposed change(s)`}</summary>
                <dl>{item.listing.changes.map((change, index) => <div key={`${change.field}:${index}`}>
                  <dt><strong>{change.field}</strong></dt><dd><small>{changesApplied ? "Before" : "Current"}</small><pre>{change.before || "(empty)"}</pre>
                    <small>{changesApplied ? "After" : "Proposed"}</small><pre>{change.after || "(empty)"}</pre></dd>
                </div>)}</dl>
              </details>}
            </td>
          </tr>;
          })}</tbody>
        </table>
      </div>
      {!items.length && attentionOnly && <p>No products need review in this job. Clear the filter to see all results.</p>}
      {!!items.length && !results.total && <p>No snapshot products match this search. Clear the search to see all products.</p>}
      <nav className="catalog-pagination" aria-label="Pricing snapshot pagination">
        <s-button disabled={results.page === 1} onClick={() => setBrowse({ jobId: job.id, search, page: results.page - 1 })}>Previous</s-button>
        <span>Page {results.page} of {results.pages}</span>
        <s-button disabled={results.page === results.pages} onClick={() => setBrowse({ jobId: job.id, search, page: results.page + 1 })}>Next</s-button>
      </nav>
      {(job.status === "PREVIEW" || job.status === "FAILED") && <ListingRecovery key={job.id} job={job} busy={busy} onPreview={onRecoveryPreview} />}
      <details className="job-details"><summary>Job details</summary><p>Reference: {job.id}</p><p>Created {timestamp(job.createdAt)}. Publishing waits for ready images. Pricing and selected updates are fixed for this job. Visibility choices apply only to new products.</p></details>
    </section> : mode === "review" ? <section className="workspace-panel workspace-empty"><h2>No snapshot to review</h2><p>Choose your products and pricing first. Nothing imports without confirmation.</p><Link className="workspace-primary" to={selectionHref}>Review selection & pricing</Link></section> : null}
    {mode === "imports" && <section className="workspace-panel" aria-labelledby="history-heading">
      <div className="catalog-toolbar"><h2 id="history-heading">Recent activity</h2><span>Latest 10 previews and imports</span></div>
      {history.length ? <ul className="job-history">{history.map((entry) => <li key={entry.id} className={job?.id === entry.id ? "is-selected" : undefined}>
        <Link to={jobHref(entry.id)}><strong>{entry.total} product{entry.total === 1 ? "" : "s"} · {statusLabel(entry.status)}</strong>
          <small>{timestamp(entry.createdAt)} · {entry.status === "PREVIEW" ? "Review before importing" : `${entry.completed}/${entry.total} completed`} · {entry.markup}% default markup</small></Link>
        <span aria-hidden="true">View</span>
      </li>)}</ul> : <div className="workspace-empty"><h2>Your imports will appear here</h2><p>Start by selecting supplier products. You’ll review exact prices before importing.</p><Link className="workspace-primary" to={catalogHref}>Browse catalog</Link></div>}
    </section>}
  </div>;
}
