import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, Link, redirect, useActionData, useLoaderData, useNavigation, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateLabAdmin } from "../shopify.server";
import { CatalogError } from "../catalog.server";
import { ImportError, markupPercent } from "../import-engine";
import { createPreview, importScreen, queueJob } from "../imports.server";
import { supplierText } from "../catalog-policy";
import "../catalog.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateLabAdmin(request);
  const ids = new URL(request.url).searchParams.getAll("job");
  if (ids.length > 1 || (ids.length && !/^[a-f0-9]{32}$/.test(ids[0]))) {
    console.warn("Rejected invalid import job identifier.");
    throw new Response("Invalid import job identifier.", { status: 400 });
  }
  return importScreen(session.shop, ids[0] || null);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticateLabAdmin(request);
  const form = await request.formData();
  try {
    const field = (name: string) => {
      const values = form.getAll(name);
      if (values.length !== 1 || typeof values[0] !== "string") throw new ImportError(`Supply exactly one ${name} field.`);
      return values[0];
    };
    const intent = field("intent");
    if (intent === "preview") {
      const job = await createPreview(session.shop, markupPercent(field("markup")), async (query, variables) => {
        const response = await admin.graphql(query, { variables, tries: 1 });
        return response.json();
      });
      return redirect(`/app/imports?job=${job.id}`);
    }
    if (intent !== "queue" && intent !== "retry") throw new ImportError("Invalid import action.");
    const id = field("job");
    if (!/^[a-f0-9]{32}$/.test(id)) throw new ImportError("Invalid import job identifier.");
    if (field("confirm") !== "draft-only") throw new ImportError("Confirm draft-only importing before queueing.");
    await queueJob(session.shop, id, intent === "retry");
    return redirect(`/app/imports?job=${id}`);
  } catch (error) {
    if (!(error instanceof ImportError) && !(error instanceof CatalogError)) throw error;
    console.warn("Draft import request rejected.", error.message);
    return data({ error: error.message }, { status: error instanceof CatalogError ? 502 : 400 });
  }
};

export default function Imports() {
  const { selected, job, history } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const active = job?.status === "QUEUED" || job?.status === "RUNNING";
  const busy = navigation.state !== "idle";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (revalidator.state === "idle") revalidator.revalidate(); }, 3000);
    return () => clearInterval(timer);
  }, [active, revalidator]);

  return <s-page heading="Pricing and draft imports">
    <s-section heading="Review saved selections">
      <div className="catalog-browser">
        <p><Link to="/app">Back to supplier catalog</Link></p>
        <p>Saved supplier IDs: {selected.length ? selected.join(", ") : "None"}. Save catalog selections before creating a preview.</p>
        <p>CAD only. Markup applies to newly created drafts, not existing retailer listings. This does not publish, start ongoing inventory sync or enable order forwarding.</p>
        {result?.error && <p role="alert">{result.error}</p>}
        <Form method="post" className="catalog-filters">
          <input type="hidden" name="intent" value="preview" />
          <label>Initial retail markup (%) <input name="markup" type="number" min="0" max="1000" step="0.01" defaultValue={job?.markup || "0"} key={job?.id || "new"} required /></label>
          <button type="submit" disabled={busy || !selected.length}>Preview draft import</button>
        </Form>
        <p>Retail price = supplier price x (1 + markup / 100), rounded to two decimal places. Shipping, taxes and fees are not added. Previews expire after 10 minutes.</p>
        {job && <>
          <h2>Job {job.id}</h2>
          <p role="status">Status: {job.status}. {job.items.filter((item) => item.status === "CREATED" || item.status === "REUSED").length} of {job.items.length} products completed. Initial markup: {job.markup}%.</p>
          {job.error && <p role="alert">{job.error}</p>}
          <div className="catalog-table"><table>
            <caption>Immutable pricing snapshot. Existing listings will be reused unchanged. Images may still be processing after draft creation.</caption>
            <thead><tr><th scope="col">Supplier product</th><th scope="col">Wholesale</th><th scope="col">New draft retail price</th><th scope="col">Result / review</th></tr></thead>
            <tbody>{job.items.map((item) => <tr key={item.supplierId}>
              <td>{supplierText(item.name)}<small>#{item.supplierId} - {item.sku || "Review variant SKUs"} - {item.variantCount} variant(s)</small></td>
              <td>{item.wholesale}</td><td>{item.retail}{item.productId && (job.status === "PREVIEW" || item.status === "REUSED") && <small>Not applied: existing listing</small>}</td>
              <td>{item.status}{job.status === "PREVIEW" && item.productId && <small>Will reuse existing listing</small>}
                {item.productId && <small><a href={`https://admin.shopify.com/store/ultralove-integration-lab/products/${item.productId.split("/").at(-1)}`} target="_blank" rel="noreferrer">Review Shopify product</a></small>}
                {item.warnings.length > 0 && <small>Review required: {item.warnings.join(", ")}</small>}
                {item.error && <p role="alert">{item.error}</p>}
              </td>
            </tr>)}</tbody>
          </table></div>
          {(job.status === "PREVIEW" || job.status === "FAILED") && <Form method="post">
            <input type="hidden" name="intent" value={job.status === "FAILED" ? "retry" : "queue"} />
            <input type="hidden" name="job" value={job.id} />
            <label><span><input name="confirm" type="checkbox" value="draft-only" required /> I confirm these selected products and prices. Create unpublished drafts only; preserve existing listings.</span></label>
            <button type="submit" disabled={busy}>{job.status === "FAILED" ? "Retry / reconcile failed items" : "Queue draft import"}</button>
          </Form>}
          {job.status === "FAILED" && <p>Retries only revisit unfinished items. An uncertain Shopify creation is reconciled before any further action; unresolved uncertainty requires manual review, never another blind creation.</p>}
          {active && <p>Background worker is processing this job. Status refreshes automatically.</p>}
        </>}
        <h2>Recent jobs</h2>
        {history.length ? <ul>{history.map((entry) => <li key={entry.id}>
          <Link to={`/app/imports?job=${entry.id}`}>{entry.id}</Link> - {entry.status}, {entry.completed}/{entry.total}, markup {entry.markup}%
        </li>)}</ul> : <p>No pricing previews or imports yet.</p>}
      </div>
    </s-section>
  </s-page>;
}

export function ErrorBoundary() { return boundary.error(useRouteError()); }
export const headers: HeadersFunction = (args) => boundary.headers(args);
