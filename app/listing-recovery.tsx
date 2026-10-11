import { Form, useSubmit } from "react-router";
import type { importScreen } from "./imports.server";

type Job = NonNullable<Awaited<ReturnType<typeof importScreen>>["job"]>;

export default function ListingRecovery({ job, busy, onPreview }: { job: Job; busy: boolean; onPreview: () => void }) {
  const submit = useSubmit();
  const recoverable = job.items.filter((item) => item.status === "FAILED" || ["BLOCKED", "CREATE", "RECREATE", "LINK"].includes(item.listing.action));
  if (!recoverable.length) return null;
  return <details className="job-details" open={recoverable.some((item) => item.listing.action === "BLOCKED")}>
    <summary>Connect existing products or recover missing listings</summary>
    <p>Verified missing products are already proposed as replacements in the review. To use an existing Shopify product instead, explicitly connect it here. Shopify identity and matching variants are checked before a new review is created. This uses the products and pricing choices from this snapshot, replacing any working selection.</p>
    <Form method="post" onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const links = { ...job.listingPolicy.links };
      for (const item of recoverable) {
        const link = form.get(`link-${item.supplierId}`);
        if (typeof link === "string" && link.trim()) links[item.supplierId] = link.trim();
        else delete links[item.supplierId];
        form.delete(`link-${item.supplierId}`);
      }
      const recreate = job.listingPolicy.recreate.filter((id) => !links[id]);
      form.set("listing-policy", JSON.stringify({ ...job.listingPolicy, links, recreate }));
      onPreview();
      submit(form, { method: "post" });
    }}>
      <input type="hidden" name="intent" value="preview" />
      <input type="hidden" name="ids" value={JSON.stringify(job.items.map((item) => item.supplierId))} />
      <input type="hidden" name="markup" value={job.markup} />
      <input type="hidden" name="markups" value={JSON.stringify(job.markups)} />
      {job.active && <input type="hidden" name="active" value="yes" />}
      {job.publicationId && <input type="hidden" name="publish" value="yes" />}
      {recoverable.map((item) => <fieldset key={item.supplierId} className="catalog-import-options">
        <legend>{item.name}</legend>
        {item.listing.message && <p>{item.listing.message}</p>}
        <label>Existing Shopify product URL or ID
          <input name={`link-${item.supplierId}`} type="text" autoComplete="off" disabled={busy}
            defaultValue={job.listingPolicy.links[item.supplierId] ?? ""} placeholder="Paste its Shopify admin product URL" />
        </label>
        <small>Leave blank to retain the reviewed action. Confirmed missing products do not need a separate replacement request. Connecting does not authorize changes beyond the fields selected for this job.</small>
      </fieldset>)}
      <p>After resolving a connection or inventory issue, create a fresh review. Pause inventory sync first if the old listing is enrolled, and reconcile any pending correction. Import confirmation is always required; a lookup failure or uncertain creation never authorizes replacement.</p>
      <s-button type="submit" variant="primary" disabled={busy} loading={busy}>Validate connections and create fresh review</s-button>
    </Form>
  </details>;
}
