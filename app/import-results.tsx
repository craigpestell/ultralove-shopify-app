import { useEffect, useState } from "react";
import { Form, Link, useRevalidator } from "react-router";
import type { importScreen } from "./imports.server";
import { MAX_PREVIEW_AGE } from "./import-engine";
import { supplierText } from "./catalog-policy";
import { pricingSignature } from "./pricing-policy";
import type { MarkupOverrides } from "./pricing-policy";

type Screen = Awaited<ReturnType<typeof importScreen>>;

export default function ImportResults({ job, history, ids, markup, markups, busy, jobHref }:
  Pick<Screen, "job" | "history"> & {
    ids: number[]; markup: string; markups: MarkupOverrides; busy: boolean; jobHref: (id: string) => string;
  }) {
  const revalidator = useRevalidator();
  const [now, setNow] = useState(() => Date.now());
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

  return <>
    <s-section heading="Preview and import results">
      {!job ? <s-paragraph>Select products, set your markup, then choose Preview import. Nothing is imported until you confirm and queue the snapshot.</s-paragraph> : <>
        <s-paragraph>Job {job.id}</s-paragraph>
        <div role="status" aria-live="polite">
          <s-paragraph>Status: {job.status}. {completed} of {job.items.length} products completed.</s-paragraph>
        </div>
        <s-paragraph>Snapshot default markup: {job.markup}%. Per-product overrides: {Object.keys(job.markups).length}.
          Saved visibility: <s-text type="strong">{job.publicationId ? "Active and published to Online Store" : job.active ? "Active; no publication requested" : "Unpublished drafts"}</s-text>.
          These settings are fixed for this job and apply only to new products.</s-paragraph>
        {job.status === "PREVIEW" && <s-paragraph>Preview valid until {new Date(Date.parse(job.createdAt) + MAX_PREVIEW_AGE).toISOString().replace("T", " ").replace(".000Z", " UTC")}. Review stock and data warnings before confirming.</s-paragraph>}
        {(expired || changed) && <s-banner heading="Create a fresh preview" tone="warning">
          {expired ? "This pricing preview has expired." : "Your selected products or markup differ from this snapshot."} Choose Preview import above to review your current settings.
        </s-banner>}
        {job.error && <div role="alert"><s-banner heading="Import needs attention" tone="critical">{job.error}</s-banner></div>}
        {/* Keyboard users need focus on the horizontally scrollable table region. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div className="catalog-table" tabIndex={0} role="region" aria-label="Pricing snapshot and product results">
          <table>
            <caption>Immutable CAD pricing snapshot. Existing listings are reused unchanged. Publishing waits for ready product images.</caption>
            <thead><tr><th scope="col">Supplier product</th><th scope="col">Markup</th><th scope="col">Wholesale</th><th scope="col">New product retail price</th><th scope="col">Result / review</th></tr></thead>
            <tbody>{job.items.map((item) => <tr key={item.supplierId}>
              <td>{supplierText(item.name)}<small>#{item.supplierId} — {item.sku || "Review variant SKUs"} — {item.variantCount} variant(s)</small></td>
              <td>{item.markup}%{job.markups[item.supplierId] !== undefined && <small>Override for all variants</small>}</td>
              <td>{item.wholesale}</td><td>{item.retail}{item.productId && (job.status === "PREVIEW" || item.status === "REUSED") && <small>Not applied: existing listing</small>}</td>
              <td>{item.status}{job.status === "PREVIEW" && item.productId && <small>Will reuse existing listing</small>}
                {item.productId && <small><a href={`https://admin.shopify.com/store/ultralove-integration-lab/products/${item.productId.split("/").at(-1)}`} target="_blank" rel="noreferrer">Review Shopify product (new tab)</a></small>}
                {item.warnings.length > 0 && <small>Review required: {item.warnings.join(", ")}</small>}
                {item.error && <p role="alert">{item.error}</p>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>
        {(job.status === "PREVIEW" || job.status === "FAILED") && <Form method="post" className="catalog-confirmation">
          <input type="hidden" name="intent" value={job.status === "FAILED" ? "retry" : "queue"} />
          <input type="hidden" name="job" value={job.id} />
          <label><span><input name="confirm" type="checkbox" value={job.confirmation} required disabled={busy || expired || changed} /> I confirm the products and CAD prices in this snapshot.
            {job.publicationId ? " Set new products to Active and publish them to the Online Store." : job.active ? " Set new products to Active without publication." : " Create unpublished drafts only."}
            {" "}Preserve existing listings.</span></label>
          <s-button type="submit" variant="primary" disabled={busy || expired || changed} loading={busy}>
            {job.status === "FAILED" ? "Retry / reconcile failed items" : "Queue import"}
          </s-button>
        </Form>}
        {job.status === "FAILED" && <s-paragraph>Retries use this saved snapshot, not edits above. Only unfinished items are revisited. Uncertain creations require reconciliation or manual review, never blind recreation.</s-paragraph>}
        {active && <s-paragraph>Background worker is processing this job. Status refreshes automatically. You can continue browsing on this page.</s-paragraph>}
      </>}
    </s-section>
    <s-section heading="Recent jobs">
      {history.length ? <ul>{history.map((entry) => <li key={entry.id}>
        <Link to={jobHref(entry.id)}>{entry.id}</Link> — {entry.status}, {entry.completed}/{entry.total} complete, default markup {entry.markup}%
      </li>)}</ul> : <s-paragraph>No pricing previews or imports yet.</s-paragraph>}
    </s-section>
  </>;
}
