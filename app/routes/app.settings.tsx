import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData, useLocation, useNavigation, useRevalidator, useRouteError, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateLabAdmin } from "../shopify.server";
import { appSettings, catalogConnection, currentRelease, inventoryHealth, requestUpdateCheck, updateSettings, updateStatus } from "../settings.server";
import { inventoryScreen } from "../inventory.server";
import type { UpdateStatus } from "../settings.server";
import { checkFeedVersion, lastFeedVersionCheck } from "../feed-version.server";
import type { FeedVersionCheck } from "../feed-version.server";
import { feedVersionLabel, feedVersionTriggerLabel, SUPPORTED_RANGE } from "../feed-version";
import { WorkspaceNav } from "../workspace";
import { workspaceHref } from "../workspace-policy";
import { PendingLink, RequestFeedback, useNetworkState } from "../network-state";
import "../catalog.css";

const REPOSITORY = "https://github.com/craigpestell/ultralove-shopify-app";
// A check usually answers within seconds; give up waiting on screen after this long.
const CHECK_WAIT_MS = 3 * 60 * 1000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateLabAdmin(request);
  const [settings, release, update, products, feedVersion] = await Promise.all([appSettings(), currentRelease(), updateStatus(),
    inventoryScreen(session.shop), lastFeedVersionCheck()]);
  return { settings, release, update, inventory: inventoryHealth(products), feedVersion };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticateLabAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "check-updates") {
    const request = await requestUpdateCheck();
    return request ? data({ intent, error: null, on: null, catalog: null, request })
      : data({ intent, error: "Update checks can only run on the lab server.", on: null, catalog: null, request: null }, { status: 503 });
  }
  if (intent === "check-catalog") return data({ intent, error: null, on: null, catalog: await catalogConnection() });
  // The loader reloads the recorded check after this, so the page shows it.
  if (intent === "check-feed-version") return data({ intent, error: null, on: null, catalog: null, checked: (await checkFeedVersion("settings")).result });
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
    case "deploying": return `Installing release${release}. The app restarts when it finishes, usually within a few minutes.`;
    case "deployed": return `Installed release${release}.`;
    case "failed": return `Release${release} failed to install. The previous version is still running; it is retried when a newer release lands.`;
    case "error": return "The check could not finish. See the deploy log on the lab host.";
  }
}

function FeedVersionFacts({ check }: { check: FeedVersionCheck | null }) {
  return <dl className="settings-facts">
    <dt>Feed version</dt>
    <dd>{check?.version ?? (check?.result === "unversioned" ? "Not reported (read as 1.1)" : "Unknown")}</dd>
    <dt>Supported versions</dt><dd>{SUPPORTED_RANGE}</dd>
    <dt>Last check</dt>
    <dd>{check ? <>{formatTime(check.checkedAt)}<small>Checked {feedVersionTriggerLabel(check.trigger)}.</small></> : "No check recorded yet"}</dd>
    {check && <><dt>Result</dt><dd>{feedVersionLabel(check.result)}</dd></>}
    {check?.reason && <><dt>{check.allowed ? "Details" : "Paused because"}</dt><dd>{check.reason}</dd></>}
  </dl>;
}

export default function Settings() {
  const { settings, release, update, inventory, feedVersion } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const location = useLocation();
  const { busy, pending } = useNetworkState();
  const saving = pending({ intent: "auto-updates" });
  const pausing = pending({ intent: "inventory-sync" });
  const checking = pending({ intent: "check-catalog" });
  const checkingVersion = pending({ intent: "check-feed-version" });
  const requestingCheck = pending({ intent: "check-updates" });
  const revalidator = useRevalidator();
  // After Check now, reload until the lab records a result carrying this request's ID.
  const checkRequest = result && "request" in result ? result.request : null;
  const answered = checkRequest && update?.request === checkRequest ? update : null;
  const [gaveUpOn, setGaveUpOn] = useState<string | null>(null);
  const awaitingCheck = Boolean(checkRequest && !answered && gaveUpOn !== checkRequest);
  useEffect(() => {
    if (!awaitingCheck || !checkRequest) return;
    const poll = setInterval(() => { if (revalidator.state === "idle") revalidator.revalidate(); }, 3000);
    const giveUp = setTimeout(() => setGaveUpOn(checkRequest), CHECK_WAIT_MS);
    return () => { clearInterval(poll); clearTimeout(giveUp); };
  }, [awaitingCheck, checkRequest, revalidator]);
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
          <p>Once a day the lab checks for a new release of this app and installs it once its checks have passed.
            Turn this off to stay on the current version. Check now and manual deploys still work while it is off.</p>
          <label className="settings-switch">
            <input type="checkbox" role="switch" checked={autoUpdates} disabled={busy} aria-busy={saving || undefined}
              onChange={toggle("auto-updates")} />
            <span>Check for updates every 24 hours</span>
            <span className="status-badge">{autoUpdates ? "On" : "Off"}</span>
          </label>
          <RequestFeedback pending={saving} pendingMessage="Saving" error={result?.error} errorHeading="Setting not saved"
            success={result?.intent === "auto-updates" && !busy
              ? result.on ? "Automatic updates are on. The next check runs within 24 hours, or use Check now." : "Automatic updates are off. The lab stays on its current version."
              : undefined} />
          <Form method="post">
            <input type="hidden" name="intent" value="check-updates" />
            <s-button type="submit" disabled={busy || awaitingCheck} loading={requestingCheck || awaitingCheck}>Check now</s-button>
          </Form>
          <small>Checks for a new release right away and installs it if its checks have passed, even while automatic updates are off.</small>
          <RequestFeedback pending={requestingCheck || awaitingCheck} pendingMessage="Checking for a new release"
            error={result?.intent === "check-updates" && !busy ? result.error ?? (answered && ["failed", "error"].includes(answered.result) ? updateSummary(answered)
              : checkRequest && gaveUpOn === checkRequest && !answered ? "No result yet. The check may still be running; its result will appear under Last update check." : undefined) : undefined}
            errorHeading="Update check did not finish"
            success={answered && !["failed", "error"].includes(answered.result) ? updateSummary(answered) : undefined}
            successHeading="Update check finished" />
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
        <section className="workspace-panel settings-panel" aria-labelledby="feed-version-heading">
          <h2 id="feed-version-heading">Supplier feed version</h2>
          <p>Before every import preview, import and inventory sync, the app checks which version of the supplier feed it is reading.
            A newer minor version only adds fields and is fine. A different major version means the feed changed in a way this app
            cannot read, so imports and inventory sync pause until the app is updated. Sync looks again every 5 minutes and resumes by itself.</p>
          {feedVersion && !feedVersion.allowed && <s-banner tone="critical" heading="Imports and inventory sync are paused">{feedVersion.reason}</s-banner>}
          <FeedVersionFacts check={feedVersion} />
          <Form method="post">
            <input type="hidden" name="intent" value="check-feed-version" />
            <s-button type="submit" disabled={busy} loading={checkingVersion}>Check feed version now</s-button>
          </Form>
          <RequestFeedback pending={checkingVersion} pendingMessage="Checking the supplier feed version"
            success={result?.intent === "check-feed-version" && !busy && feedVersion?.allowed ? "Feed version checked. The result is shown above." : undefined} />
        </section>
      </div>
    </div>
  </s-page>;
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
