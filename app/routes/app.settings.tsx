import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, Form, useActionData, useLoaderData, useNavigation, useRouteError, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateLabAdmin } from "../shopify.server";
import { appSettings, catalogConnection, currentRelease, setAutoUpdates, updateStatus } from "../settings.server";
import type { UpdateStatus } from "../settings.server";
import { WorkspaceNav } from "../workspace";
import { RequestFeedback, useNetworkState } from "../network-state";
import "../catalog.css";

const REPOSITORY = "https://github.com/craigpestell/ultralove-shopify-app";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticateLabAdmin(request);
  const [settings, release, update] = await Promise.all([appSettings(), currentRelease(), updateStatus()]);
  return { settings, release, update };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticateLabAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "check-catalog") return data({ intent, error: null, autoUpdates: null, catalog: await catalogConnection() });
  const values = form.getAll("autoUpdates");
  if (intent !== "auto-updates" || values.length !== 1 || !["on", "off"].includes(String(values[0]))) {
    return data({ intent: null, error: "Choose on or off for automatic updates.", autoUpdates: null, catalog: null }, { status: 400 });
  }
  const autoUpdates = values[0] === "on";
  await setAutoUpdates(autoUpdates);
  return data({ intent, error: null, autoUpdates, catalog: null });
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
  const { settings, release, update } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const { busy, pending } = useNetworkState();
  const saving = pending({ intent: "auto-updates" });
  const checking = pending({ intent: "check-catalog" });
  // Show the requested position while it saves, so the switch does not snap back.
  const requested = saving ? navigation.formData?.get("autoUpdates") : null;
  const autoUpdates = requested ? requested === "on" : settings.autoUpdates;
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
              onChange={(event) => submit({ intent: "auto-updates", autoUpdates: event.currentTarget.checked ? "on" : "off" }, { method: "post" })} />
            <span>Check for updates every 5 minutes</span>
            <span className="status-badge">{autoUpdates ? "On" : "Off"}</span>
          </label>
          {settings.updatedAt && !saving && <small>Last changed {formatTime(settings.updatedAt)}</small>}
          <RequestFeedback pending={saving} pendingMessage="Saving" error={result?.error} errorHeading="Setting not saved"
            success={result?.intent === "auto-updates" && !busy
              ? result.autoUpdates ? "Automatic updates are on. The next check runs within 5 minutes." : "Automatic updates are off. The lab stays on its current version."
              : undefined} />
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
