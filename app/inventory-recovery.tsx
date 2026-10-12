import { Form, useSubmit } from "react-router";
import type { inventoryScreen } from "./inventory.server";
import { defaultListingPolicy } from "./listing-policy";

type Product = Awaited<ReturnType<typeof inventoryScreen>>[number];

export default function InventoryRecovery({ product, busy, action }: { product: Product; busy: boolean; action: string }) {
  const submit = useSubmit();
  return <details>
    <summary>Recover deleted listing</summary>
    <p>Nothing is recreated automatically. Review a new unpublished draft or connect an existing product.
      Previous retailer edits and collection membership are not restored. Supplier sync remains off after recovery.</p>
    {(["recreate", "connect"] as const).map((mode) => <Form key={mode} method="post" action={action}
      onSubmit={mode === "connect" ? (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        form.set("listing-policy", JSON.stringify({ ...defaultListingPolicy(), links: { [product.supplierId]: form.get("connection") } }));
        form.delete("connection");
        submit(form, { method: "post", action });
      } : undefined}>
      <input type="hidden" name="intent" value="preview" />
      <input type="hidden" name="ids" value={JSON.stringify([product.supplierId])} />
      <input type="hidden" name="markup" value={product.markup} />
      <input type="hidden" name="markups" value="{}" />
      <input type="hidden" name="fulfillment-modes" value={JSON.stringify(
        product.fulfillmentMode === "DROPSHIPPING" ? { [product.supplierId]: "DROPSHIPPING" } : {})} />
      <input type="hidden" name="listing-policy" value={JSON.stringify({
        ...defaultListingPolicy(), recreate: mode === "recreate" ? [product.supplierId] : [],
      })} />
      {mode === "connect" && <label>Existing Shopify product URL or ID
        <input name="connection" type="text" maxLength={1000} autoComplete="off" required disabled={busy}
          placeholder="Paste its Shopify admin product URL" />
      </label>}
      <s-button type="submit" disabled={busy}>{mode === "recreate" ? "Review re-import as a new draft" : "Review connection to existing product"}</s-button>
    </Form>)}
    <p>These actions create a fresh review for this product and replace the working selection. Import confirmation is still required.
      A pending stock correction must be reconciled before changing its mapping.</p>
  </details>;
}
