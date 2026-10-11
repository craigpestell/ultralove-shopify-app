import type { ListingPolicy } from "./listing-policy";

export default function ListingOptions({ policy, disabled, onChange }: {
  policy: ListingPolicy; disabled: boolean; onChange: (policy: ListingPolicy) => void;
}) {
  return <fieldset className="catalog-import-options">
    <legend>Existing Shopify products</legend>
    <label>When a linked product already exists
      <select value={policy.mode} disabled={disabled} onChange={(event) => onChange({
        ...policy, mode: event.currentTarget.value === "UPDATE" ? "UPDATE" : "KEEP",
      })}>
        <option value="KEEP">Keep unchanged (recommended)</option>
        <option value="UPDATE">Update from UltraLove</option>
      </select>
    </label>
    {policy.mode === "UPDATE" ? <>
      <p>Choose what to refresh. Review the current and proposed values before confirming.</p>
      <label><span><input type="checkbox" checked={policy.content} disabled={disabled}
        onChange={(event) => onChange({ ...policy, content: event.currentTarget.checked })} /> Product name, description, and vendor</span></label>
      <label><span><input type="checkbox" checked={policy.images} disabled={disabled}
        onChange={(event) => onChange({ ...policy, images: event.currentTarget.checked })} /> Add supplier images</span></label>
      <label><span><input type="checkbox" checked={policy.prices} disabled={disabled}
        onChange={(event) => onChange({ ...policy, prices: event.currentTarget.checked })} /> Retail prices using the selected markup</span></label>
      {!policy.content && !policy.images && !policy.prices && <p role="alert">Select at least one field to update.</p>}
      <p>Existing images are retained. Product and variant IDs, URLs, publication, collections, inventory, and unselected fields stay unchanged.</p>
    </> : <p>Existing products, including their prices, stay unchanged. Markup applies only to new products.</p>}
    <p>Products not already linked to UltraLove require an explicit connection in the review step.</p>
  </fieldset>;
}
