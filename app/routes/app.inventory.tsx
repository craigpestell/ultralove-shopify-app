import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, Link, redirect, useActionData, useLoaderData, useNavigation, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateLabAdmin } from "../shopify.server";
import { inventoryControl, inventoryScreen } from "../inventory.server";
import { InventoryError } from "../inventory-engine";
import { supplierText } from "../catalog-policy";
import "../catalog.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateLabAdmin(request);
  return { products: await inventoryScreen(session.shop) };
};
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticateLabAdmin(request);
  const form = await request.formData();
  try {
    const field = (name: string) => {
      const values = form.getAll(name);
      if (values.length !== 1 || typeof values[0] !== "string") throw new InventoryError(`Supply exactly one ${name} field.`);
      return values[0];
    };
    const intent = field("intent");
    const id = field("supplierId");
    if (!/^[1-9]\d*$/.test(id)) throw new InventoryError("Invalid supplier product ID.");
    await inventoryControl(session.shop, Number(id), intent, async (query, variables) => {
      const response = await admin.graphql(query, { variables, tries: 1 });
      return response.json();
    }, intent === "enable" ? field("confirm") : undefined);
    return redirect("/app/inventory");
  } catch (error) {
    if (!(error instanceof InventoryError)) throw error;
    console.warn("Inventory control rejected.", error.message);
    return data({ error: error.message }, { status: 400 });
  }
};

export default function Inventory() {
  const { products } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const busy = navigation.state !== "idle";
  const active = products.some((product) => product.enabled);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (revalidator.state === "idle") revalidator.revalidate(); }, 10000);
    return () => clearInterval(timer);
  }, [active, revalidator]);
  return <s-page heading="Inventory synchronization">
    <s-section heading="Manage imported products">
      <div className="catalog-browser">
        <p><Link to="/app">Catalog, pricing and product imports</Link></p>
        <p>Inventory sync is opt-in per product. Enabled products run about every five minutes, after queued imports.
          Sync changes supplier-backed on-hand stock only. Shopify order reservations remain in place.
          Prices, descriptions, publication and order forwarding are not changed.</p>
        <p>Unknown, unmanaged, shared, out-of-stock or withdrawn supplier inventory becomes zero with review warnings where needed.
          New supplier variants are not added automatically. Pause stops new updates; an update already sent to Shopify may finish.
          Changing catalog selections does not pause enrolled products.</p>
        {result?.error && <p role="alert">{result.error}</p>}
        {!products.length && <p>No verified imported products yet. Import products before enrolling them in synchronization.</p>}
        {products.length > 0 && <div className="catalog-table"><table>
          <caption>Imported product inventory enrollment and latest results</caption>
          <thead><tr><th scope="col">Product</th><th scope="col">Sync status</th><th scope="col">Last success</th><th scope="col">Controls</th></tr></thead>
          <tbody>{products.map((product) => <tr key={product.supplierId}>
            <td>{supplierText(product.name)} <small>#{product.supplierId} - {product.sku}</small>
              <p><a href={`https://admin.shopify.com/store/ultralove-integration-lab/products/${product.productId?.split("/").at(-1)}`}
                target="_blank" rel="noreferrer">Review in Shopify</a></p></td>
            <td>{product.status}{product.variantCount !== null && <small>{product.variantCount} mapped variants</small>}
              {product.error && <p role="alert">{product.error}</p>}
              {product.nextRunAt && <small>Next due: {product.nextRunAt}</small>}</td>
            <td>{product.lastSuccessAt || "Not synchronized yet"}</td>
            <td><Form method="post">
              <input type="hidden" name="supplierId" value={product.supplierId} />
              {!product.enabled ? <>
                <input type="hidden" name="intent" value="enable" />
                <label><input type="checkbox" name="confirm" value="inventory-only" required disabled={busy} />
                  I approve inventory-only sync for supplier product {product.supplierId}.</label>
                <button type="submit" disabled={busy}>Enable inventory sync</button>
              </> : <>
                <button type="submit" name="intent" value="pause" disabled={busy}>Pause sync</button>
                {" "}<button type="submit" name="intent" value="sync-now" disabled={busy || product.status === "RUNNING"}>Sync now</button>
              </>}
            </Form></td>
          </tr>)}</tbody>
        </table></div>}
      </div>
    </s-section>
  </s-page>;
}
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
