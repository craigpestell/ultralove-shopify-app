import type { ChangeEvent } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData, useLocation, useNavigation, useRouteError, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateLabAdmin } from "../shopify.server";
import { appSettings, catalogConnection, currentRelease, inventoryHealth, updateSettings, updateStatus } from "../settings.server";
import { inventoryScreen } from "../inventory.server";
import type { UpdateStatus } from "../settings.server";
import { WorkspaceNav } from "../workspace";
import { workspaceHref } from "../workspace-policy";
import { PendingLink, RequestFeedback, useNetworkState } from "../network-state";
import "../catalog.css";

const REPOSITORY = "https://github.com/craigpestell/ultralove-shopify-app";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateLabAdmin(request);
  const [settings, release, update, products] = await Promise.all([appSettings(), currentRelease(), updateStatus(), inventoryScreen(session.shop)]);
  return { settings, release, update, inventory: inventoryHealth(products) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticateLabAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "check-catalog") return data({ intent, error: null, on: null, catalog: await catalogConnection() });
  const values = form.getAll("value");
  if ((intent !== "auto-updates" && intent !== "inventory-sync") || values.length !== 1 || !["on", "off"].includes(String(values[0]))) {
    return data({ intent: null, error: "Choose on or off for this setting.", on: null, catalog: null }, { status: 400 });
  }
  const on = values[0] === "on";
  await updateSettings(intent === "auto-updates" ? { autoUpdates: on } : { inventoryPaused: !on });
  return data({ intent, error: null, on, catalog: null });
};

const formatTime = (value: string) => new Date(value).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
const short = (release: string) => release.slice(0, 7);

function updateSummary(update: UpdateStatus) {
  const release = update.release ? ` ${short(update.release)}` : "";
  switch (update.result) {
    case "off": return "Skipped because automatic updates are off.";
    case "current": return "No new release. The lab is up to date.";
    case "waiting": return `Found release${release}, waiting for its checks (${update.checks ?? "unknown"}).`;
    case "deployed": return `Installed release${release}.`;
    case "failed": return `Release${release} failed to install. The previous version is still running; it is retried when a newer release lands.`;
    case "error": return "The check could not finish. See the deploy log on the lab host.";
  }
}

export default function Settings() {
  const { settings, release, update, inventory } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const location = useLocation();
  const { busy, pending } = useNetworkState();
  const saving = pending({ intent: "auto-updates" });
  const pausing = pending({ intent: "inventory-sync" });
  const checking = pending({ intent: "check-catalog" });
  // Show the requested position while it saves, so a switch does not snap back.
  const requested = navigation.formData?.get("value");
  const autoUpdates = saving ? requested === "on" : settings.autoUpdates;
  const inventorySync = pausing ? requested === "on" : !settings.inventoryPaused;
  const toggle = (intent: string) => (event: ChangeEvent<HTMLInputElement>) =>
    submit({ intent, value: event.currentTarget.checked ? "on" : "off" }, { method: "post" });
  const catalog = result?.intent === "check-catalog" ? result.catalog : null;
  return <s-page heading="UltraLove Catalog" inlineSize="large">
    <div className="catalog-browser workspace">
      <WorkspaceNav current="settings" />
      <header className="workspace-header"><div><h1>Settings</h1><p>Updates, version and supplier connection for the UltraLove Catalog app on the integration lab.</p></div></header>
      <div className="settings-layout">
        <section className="workspace-panel settings-panel" aria-labelledby="auto-updates-heading">
          <h2 id="auto-updates-heading">Automatic app updates</h2>
          <p>Every 5 minutes the lab checks for a new release of this app and installs it once its checks have passed.
            Turn this off to stay on the current version. Manual deploys still work while it is off.</p>
          <label className="settings-switch">
            <input type="checkbox" role="switch" checked={autoUpdates} disabled={busy} aria-busy={saving || undefined}
              onChange={toggle("auto-updates")} />
            <span>Check for updates every 5 minutes</span>
            <span className="status-badge">{autoUpdates ? "On" : "Off"}</span>
          </label>
          <RequestFeedback pending={saving} pendingMessage="Saving" error={result?.error} errorHeading="Setting not saved"
            success={result?.intent === "auto-updates" && !busy
              ? result.on ? "Automatic updates are on. The next check runs within 5 minutes." : "Automatic updates are off. The lab stays on its current version."
              : undefined} />
        </section>
        <section className="workspace-panel settings-panel" aria-labelledby="inventory-heading">
          <h2 id="inventory-heading">Inventory sync</h2>
          <p>Products with sync on update their stock from the supplier about every 5 minutes. Pause sync for every product at once
            during maintenance or a supplier problem. Each product keeps its own setting and catches up when sync resumes.</p>
          <label className="settings-switch">
            <input type="checkbox" role="switch" checked={inventorySync} disabled={busy} aria-busy={pausing || undefined}
              onChange={toggle("inventory-sync")} />
            <span>Run inventory sync</span>
            <span className="status-badge">{inventorySync ? "Running" : "Paused"}</span>
          </label>
          <RequestFeedback pending={pausing} pendingMessage="Saving"
            success={result?.intent === "inventory-sync" && !busy
              ? result.on ? "Inventory sync resumed. Products that are due update first." : "Inventory sync paused for every product. An update already sent to Shopify may finish."
              : undefined} />
          <dl className="settings-facts">
            <dt>Products with sync on</dt><dd>{inventory.enabled}</dd>
            <dt>Need review</dt><dd>{inventory.review ? <PendingLink to={workspaceHref(location.search, "inventory")}>{inventory.review} (review on Inventory)</PendingLink> : 0}</dd>
            <dt>Last successful sync</dt><dd>{inventory.lastSuccessAt ? formatTime(inventory.lastSuccessAt) : "None yet"}</dd>
            {inventory.enabled > 0 && !settings.inventoryPaused && inventory.nextRunAt && <><dt>Next due</dt><dd>{formatTime(inventory.nextRunAt)}</dd></>}
          </dl>
        </section>
        <section className="workspace-panel settings-panel" aria-labelledby="version-heading">
          <h2 id="version-heading">App version</h2>
          {release ? <dl className="settings-facts">
            <dt>Running release</dt>
            <dd><a href={`${REPOSITORY}/commit/${release.release}`} target="_blank" rel="noreferrer">{short(release.release)} (opens in a new tab)</a></dd>
            <dt>Installed</dt><dd>{formatTime(release.deployedAt)}</dd>
            <dt>Last update check</dt>
            <dd>{update ? <>{formatTime(update.checkedAt)}<small>{updateSummary(update)}</small></> : "No check recorded yet"}</dd>
          </dl> : <p>Release details are only available on the lab server.</p>}
        </section>
        <section className="workspace-panel settings-panel" aria-labelledby="catalog-heading">
          <h2 id="catalog-heading">Supplier catalog connection</h2>
          <p>Products, prices and stock come from the UltraLove supplier feed. Check that the feed answers before importing or when sync reports a connection problem.</p>
          <Form method="post">
            <input type="hidden" name="intent" value="check-catalog" />
            <s-button type="submit" disabled={busy} loading={checking}>Check connection</s-button>
          </Form>
          <RequestFeedback pending={checking} pendingMessage="Contacting the supplier feed"
            error={catalog && !catalog.connected && !busy ? catalog.error : undefined} errorHeading="Supplier catalog unavailable"
            success={catalog?.connected && !busy ? `The supplier feed answered in ${(catalog.milliseconds / 1000).toFixed(1)} seconds.` : undefined}
            successHeading="Connected" />
        </section>
      </div>
    </div>
  </s-page>;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
