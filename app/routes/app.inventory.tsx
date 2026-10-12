import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, Link, useActionData, useLoaderData, useLocation, useNavigation, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateLabAdmin } from "../shopify.server";
import { enableAllInventory, inventoryControl, inventoryScreen } from "../inventory.server";
import { InventoryError } from "../inventory-engine";
import { supplierText } from "../catalog-policy";
import { useWorkspace, WorkspaceNav } from "../workspace";
import { statusLabel, workspaceHref } from "../workspace-policy";
import { fulfillmentLabel } from "../fulfillment-policy";
import InventoryRecovery from "../inventory-recovery";
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
    const api = async (query: string, variables: Record<string, unknown>) => {
      const response = await admin.graphql(query, { variables, tries: 1 });
      return response.json();
    };
    if (intent === "enable-all") {
      if (form.has("supplierId")) throw new InventoryError("Bulk inventory enrollment applies to all current imported products, not individual IDs.");
      const bulk = await enableAllInventory(session.shop, api, field("confirm"));
      return data({ error: bulk.error, supplierId: null, intent, bulk }, { status: bulk.error ? 502 : 200 });
    }
    const id = field("supplierId");
    if (!/^[1-9]\d*$/.test(id)) throw new InventoryError("Invalid supplier product ID.");
    await inventoryControl(session.shop, Number(id), intent, api, intent === "enable" ? field("confirm") : undefined);
    return data({ error: null, supplierId: Number(id), intent, bulk: null });
  } catch (error) {
    if (!(error instanceof InventoryError)) throw error;
    console.warn("Inventory control rejected.", error.message);
    return data({ error: error.message, supplierId: null, intent: null, bulk: null }, { status: 400 });
  }
};

export default function Inventory() {
  const { products } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const { draft } = useWorkspace();
  const location = useLocation();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState(() => new URLSearchParams(location.search).get("filter") === "deleted" ? "deleted" : "all");
  const busy = navigation.state !== "idle";
  useEffect(() => {
    if (!products.length) return;
    const timer = setInterval(() => { if (revalidator.state === "idle") revalidator.revalidate(); }, 10000);
    return () => clearInterval(timer);
  }, [products.length, revalidator]);
  const currentProducts = products.filter((product) => !product.deletedAt);
  const deleted = products.length - currentProducts.length;
  const enabled = currentProducts.filter((product) => product.enabled).length;
  const eligible = currentProducts.filter((product) => product.fulfillmentMode === "DROPSHIPPING");
  const needsReview = currentProducts.filter((product) => product.error || ["FAILED", "REVIEW"].includes(product.status)).length;
  const visible = products.filter((product) =>
    (!search || `${supplierText(product.name)} ${product.sku}`.toLowerCase().includes(search.toLowerCase())) &&
    (filter === "deleted" ? Boolean(product.deletedAt) : !product.deletedAt &&
      (filter === "all" || (filter === "enabled" && product.enabled) || (filter === "off" && !product.enabled) ||
        (filter === "review" && (product.error || ["FAILED", "REVIEW"].includes(product.status))))));
  const catalogHref = workspaceHref(location.search, "catalog", draft.browse);
  const formatTime = (value: string | null) => value ? new Date(value).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "Not synchronized yet";
  return <s-page heading="UltraLove Catalog" inlineSize="large">
      <div className="catalog-browser workspace">
        <WorkspaceNav current="inventory" />
        <header className="workspace-header"><div><h1>Inventory</h1><p>Manage your own stock for catalog-only products. Opt into supplier sync only for dropshipping products.</p></div>
          <Link to={catalogHref}>Add products from catalog</Link></header>
        <div className="inventory-overview" aria-label="Inventory overview">
          <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}><strong>{currentProducts.length}</strong> Current imported products</button>
          <button type="button" aria-pressed={filter === "enabled"} onClick={() => setFilter("enabled")}><strong>{enabled}</strong> Sync on</button>
          <button type="button" aria-pressed={filter === "review"} onClick={() => setFilter("review")}><strong>{needsReview}</strong> Need review</button>
          <button type="button" aria-pressed={filter === "deleted"} onClick={() => setFilter("deleted")}><strong>{deleted}</strong> Deleted / archived</button>
        </div>
        {eligible.length > 0 && <section className="workspace-panel" aria-label="Enable all imported inventory">
          <h2>Enable inventory sync for all</h2>
          <p>Apply to {eligible.length} dropshipping products, regardless of the search or filter below. Catalog-only products are excluded.
            Already-enabled products stay unchanged. Listings with missing mappings, running cycles or protected stock corrections are skipped with a reason.
            Future imports still require explicit enrollment.</p>
          <Form method="post">
            <input type="hidden" name="intent" value="enable-all" />
            <label className="checkbox-label"><span><input type="checkbox" name="confirm" value="inventory-all-current" required disabled={busy} />
              I approve inventory-only sync for all currently imported eligible products. Prices and publication stay unchanged.</span></label>
            <s-button type="submit" variant="primary" disabled={busy || eligible.every((product) => product.enabled)}
              loading={busy && navigation.formData?.get("intent") === "enable-all"}>Enable inventory sync for all</s-button>
            {busy && navigation.formData?.get("intent") === "enable-all" && <p role="status">Verifying all imported listings and enabling eligible products. This can take a moment for a large catalog.</p>}
          </Form>
          {result?.bulk && <div role="status">
            <p>{result.bulk.enabled} products enabled; {result.bulk.alreadyEnabled} already enabled; {result.bulk.blocked.length} skipped out of {result.bulk.total} imported products.</p>
            {result.bulk.blocked.length > 0 && <details open><summary>Review skipped products</summary><ul>
              {result.bulk.blocked.map((product) => <li key={product.supplierId}>
                <strong>{supplierText(product.name)}</strong> ({product.sku}): {product.error}
              </li>)}
            </ul></details>}
          </div>}
        </section>}
        <section className="workspace-panel" aria-label="Imported inventory">
        <div className="catalog-filters">
          <label>Search imported products<input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} maxLength={100} /></label>
          <label>Sync status<select value={filter} onChange={(event) => setFilter(event.currentTarget.value)}><option value="all">Current products</option><option value="enabled">Sync on</option><option value="off">Sync off / paused</option><option value="review">Needs review</option><option value="deleted">Deleted / archived</option></select></label>
          <span>{visible.length} of {filter === "deleted" ? deleted : currentProducts.length} {filter === "deleted" ? "archived" : "current"} products</span>
        </div>
        <details className="inventory-policy"><summary>How inventory sync works</summary>
          <p>Inventory sync is opt-in: enable individual products or confirm all currently imported eligible products.
            Deleted Shopify listings are archived and excluded from enrollment. Deletion notifications and periodic verification cover all imported products, including catalog-only products. API failures never count as deletions.
            Enabled products are scheduled about every five minutes, after queued imports, in bounded cross-product batches.
            Sync changes supplier-backed on-hand stock only. Shopify order reservations remain in place.
            Prices, descriptions, publication and order forwarding are not changed.</p>
          <p>Unknown, unmanaged, shared, out-of-stock or withdrawn supplier inventory becomes zero with review warnings where needed.
            New supplier variants are not added automatically. Pause stops new updates; an update already sent to Shopify may finish.
            Changing catalog selections does not pause enrolled products.</p>
          <p>If a cross-product stock correction has an uncertain response, its exact request is retained for every participating product.
            Pausing any participant prevents replay until the participating products are verified and resumed.
            Products with a protected correction are not resumed by Enable all.</p>
        </details>
        {result?.error && <p role="alert">{result.error}</p>}
        {result?.intent && result.intent !== "enable-all" && <p role="status">{result.intent === "pause" ? "Sync paused" : result.intent === "enable" ? "Inventory sync enabled" : "Inventory update queued"} for {supplierText(products.find((product) => product.supplierId === result.supplierId)?.name || "this product")}.</p>}
        {!products.length && <div className="workspace-empty"><h2>No imported products yet</h2><p>Import products before enabling inventory synchronization.</p><Link className="workspace-primary" to={catalogHref}>Browse catalog</Link></div>}
        {products.length > 0 && !visible.length && <div className="workspace-empty">
          {!currentProducts.length && filter !== "deleted" ? <>
            <h2>No current imported products</h2><p>Deleted listings are retained in the archive, not active inventory.</p>
            <button type="button" onClick={() => { setSearch(""); setFilter("deleted"); }}>View deleted / archived products</button>
          </> : <><h2>No matching imported products</h2><button type="button" onClick={() => { setSearch(""); setFilter("all"); }}>Clear filters</button></>}
        </div>}
        {visible.length > 0 && <>
        {/* Keyboard users can focus and scroll this region without moving the whole page. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div className="catalog-table" tabIndex={0} role="region" aria-label="Imported inventory results"><table>
          <caption className="visually-hidden">Imported product inventory enrollment and latest results</caption>
          <thead><tr><th scope="col">Product</th><th scope="col">Sync status</th><th scope="col">Last successful sync</th><th scope="col">Actions</th></tr></thead>
          <tbody>{visible.map((product) => <tr key={product.supplierId}>
            <td><strong>{supplierText(product.name)}</strong><small>{product.sku}</small><small>{fulfillmentLabel(product.fulfillmentMode)}</small>
              {!product.deletedAt && <p><a href={`https://admin.shopify.com/store/ultralove-integration-lab/products/${product.productId?.split("/").at(-1)}`}
                target="_blank" rel="noreferrer">Open in Shopify (new tab)</a></p>}
              {product.deletedAt && <small>Deletion recorded: {formatTime(product.deletedAt)}</small>}</td>
            <td><span className="status-badge">{statusLabel(product.status)}</span>{product.variantCount !== null && <small>{product.variantCount} mapped variants</small>}
              {product.error && <details><summary>Review sync issue</summary><p>{product.error}</p>{!product.deletedAt && <p>Review the product in Shopify. If sync is on, choose Sync now after resolving the issue; if it is off, review and approve enrollment again.</p>}</details>}
              {product.nextRunAt && product.enabled && <small>Next due: {formatTime(product.nextRunAt)}</small>}</td>
            <td>{formatTime(product.lastSuccessAt)}</td>
            <td>{product.deletedAt ? <InventoryRecovery product={product} busy={busy} action={`${workspaceHref(location.search, "review", draft.browse)}&index`} /> : <Form method="post">
              <input type="hidden" name="supplierId" value={product.supplierId} />
              {product.fulfillmentMode === "CATALOG" && !product.enabled ? <p>Your own stock — supplier sync unavailable. Set inventory in Shopify.</p> : !product.enabled ? <>
                <input type="hidden" name="intent" value="enable" />
                <details><summary>Enable inventory sync</summary>
                  <p>Update supplier-backed stock about every five minutes. Prices and publication stay unchanged.</p>
                  <label className="checkbox-label"><span><input type="checkbox" name="confirm" value="inventory-only" required disabled={busy} />
                    I approve inventory-only sync for {supplierText(product.name)}.</span></label>
                  <s-button type="submit" disabled={busy} loading={busy && navigation.formData?.get("supplierId") === String(product.supplierId)}>Enable inventory sync</s-button>
                </details>
              </> : <>
                <div className="inventory-actions"><button type="submit" name="intent" value="pause" disabled={busy}>Pause sync</button>
                {product.fulfillmentMode === "DROPSHIPPING" && <button type="submit" name="intent" value="sync-now" disabled={busy || product.status === "RUNNING"}>Sync now</button>}</div>
              </>}
            </Form>}</td>
          </tr>)}</tbody>
        </table></div></>}
        </section>
      </div>
  </s-page>;
}
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
