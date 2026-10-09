import { useEffect, useState } from "react";
import { Form, Link, useRevalidator } from "react-router";
import type { importScreen } from "./imports.server";
import { MAX_PREVIEW_AGE } from "./import-engine";
import { supplierText } from "./catalog-policy";
import { pricingSignature } from "./pricing-policy";
import type { MarkupOverrides } from "./pricing-policy";
import { statusLabel } from "./workspace-policy";

type Screen = Awaited<ReturnType<typeof importScreen>>;
const timestamp = (value: string) => new Date(value).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });

export default function ImportResults({ job, history, ids, markup, markups, busy, jobHref, mode, selectionHref, catalogHref, inventoryHref }:
  Pick<Screen, "job" | "history"> & {
    ids: number[]; markup: string; markups: MarkupOverrides; busy: boolean; jobHref: (id: string) => string;
    mode: string; selectionHref: string; catalogHref: string; inventoryHref: string;
  }) {
  const revalidator = useRevalidator();
  const [now, setNow] = useState(() => Date.now());
  const [attentionOnly, setAttentionOnly] = useState(false);
  const active = job?.status === "QUEUED" || job?.status === "RUNNING";
  useEffect(() => {
    if (!job || (!active && job.status !== "PREVIEW")) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (active && revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [active, job, revalidator]);
  const expired = job?.status === "PREVIEW" && now - Date.parse(job.createdAt) > MAX_PREVIEW_AGE;
  const changed = job?.status === "PREVIEW" &&
    pricingSignature(ids, markup, markups) !== pricingSignature(job.items.map((item) => item.supplierId), job.markup, job.markups);
  const completed = job?.items.filter((item) => item.status === "CREATED" || item.status === "REUSED").length ?? 0;
  const attention = job?.items.filter((item) => item.error || item.warnings.length).length ?? 0;
  const items = job?.items.filter((item) => !attentionOnly || !attention || item.error || item.warnings.length) ?? [];

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
        <p><small>Existing listings</small><strong>Reused without changes</strong></p></div>
      {(expired || changed) && <s-banner heading="Create a fresh preview" tone="warning">
        {expired ? "This pricing preview has expired." : "Your selection or markup has changed."} <Link to={selectionHref}>Return to selection & pricing</Link> to create a new snapshot.
      </s-banner>}
      {job.error && <div role="alert"><s-banner heading="Import needs attention" tone="critical">{job.error}</s-banner></div>}
      {job.status === "COMPLETE" && <s-banner heading="Import completed" tone="success">
        Review each product below. Inventory sync remains opt-in. <Link to={inventoryHref}>Manage inventory</Link> or <Link to={catalogHref}>select more products</Link>.
      </s-banner>}
      {active && <p>Processing in the background. Results refresh automatically; you can leave this view without stopping the import.</p>}
      {attention > 0 && <label className="checkbox-label"><span><input type="checkbox" checked={attentionOnly} onChange={(event) => setAttentionOnly(event.currentTarget.checked)} /> Show only products needing review ({attention})</span></label>}
      {/* A focusable region lets keyboard users scroll exact pricing and results. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className="catalog-table" tabIndex={0} role="region" aria-label="Pricing snapshot and product results">
        <table>
          <caption>Exact variant prices in CAD. This snapshot cannot be edited.</caption>
          <thead><tr><th scope="col">Product</th><th scope="col">Markup</th><th scope="col">Wholesale</th><th scope="col">Retail</th><th scope="col">Result / review</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.supplierId}>
            <td><strong>{supplierText(item.name)}</strong><small>{item.sku || "Review variant SKUs"} · {item.variantCount} variant(s)</small></td>
            <td>{item.markup}%{job.markups[item.supplierId] !== undefined && <small>Product override</small>}</td>
            <td>{item.wholesale}</td><td><strong>{item.retail}</strong>{item.productId && (job.status === "PREVIEW" || item.status === "REUSED") && <small>Not applied to existing listing</small>}</td>
            <td><span className="status-badge">{job.status === "PREVIEW" ? item.productId ? "Existing listing kept" : "Ready for import" : statusLabel(item.status)}</span>
              {item.productId && <small><a href={`https://admin.shopify.com/store/ultralove-integration-lab/products/${item.productId.split("/").at(-1)}`} target="_blank" rel="noreferrer">Open in Shopify (new tab)</a></small>}
              {item.warnings.length > 0 && <details><summary>Review {item.warnings.length} warning(s)</summary><ul>{item.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details>}
              {item.error && <p role="alert">{item.error}</p>}
            </td>
          </tr>)}</tbody>
        </table>
      </div>
      {!items.length && attentionOnly && <p>No products need review in this job. Clear the filter to see all results.</p>}
      {(job.status === "PREVIEW" || job.status === "FAILED") && <Form key={`${job.id}:${job.status}`} method="post" className="catalog-confirmation selection-bar">
        <input type="hidden" name="intent" value={job.status === "FAILED" ? "retry" : "queue"} />
        <input type="hidden" name="job" value={job.id} />
        <div><label className="checkbox-label"><span><input name="confirm" type="checkbox" value={job.confirmation} required disabled={busy || expired || changed} /> I confirm these products and CAD prices.
          {job.publicationId ? " Activate and publish new products to Online Store." : job.active ? " Activate new products without publication." : " Create unpublished drafts only."}
          {" "}Keep existing listings unchanged.</span></label>
          {job.status === "FAILED" && <small>Retries reconcile unfinished items only, using this snapshot. Uncertain creations require review, never blind recreation.</small>}</div>
        <s-button type="submit" variant="primary" disabled={busy || expired || changed} loading={busy}>
          {job.status === "FAILED" ? "Retry unfinished items" : `Import ${job.items.length} product${job.items.length === 1 ? "" : "s"}`}
        </s-button>
      </Form>}
      <details className="job-details"><summary>Job details</summary><p>Reference: {job.id}</p><p>Created {timestamp(job.createdAt)}. Publishing waits for ready images. Pricing and visibility are fixed for this job and apply only to new products.</p></details>
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
