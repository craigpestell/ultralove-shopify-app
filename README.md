# UltraLove Shopify app

Separate web interface for the existing **UltraLove Dropshipping Lab** app,
scaffolded from Shopify's MIT-licensed React Router template. The upstream
license remains in [LICENSE.md](LICENSE.md).

## Status

The embedded catalog browser and saved selections are deployed and connected
to the real development feed.
The interface accepts only
`ultralove-integration-lab.myshopify.com`. Shopify authentication and signed
webhook verification use the official SDK. Lab-store checks additionally apply
to login, authenticated routes and webhook handlers. The template's product
creation demo has been removed.

The browser provides name/SKU search, category navigation, bounded
50-parent pages and per-store saved selections capped at 50 parents. Saving
does not import, publish, sync inventory or approve forwarding. It validates
published selections against the real feed before committing app-owned SQLite
state; no WordPress product mappings or settings are changed.
The table's **Select all on this page** checkbox selects or deselects only the
visible page, preserving choices on other pages. It shows a partial state when
some rows are selected. If the full page would exceed the 50-parent total, the
control is disabled with an explanation; clear choices or select rows individually.
Bulk selection changes the working selection only. The merchant workspace separates
**Catalog**, **Selection & pricing**, **Review import**, **Imports**, and **Inventory**
by task. Catalog rows pair wholesale prices with retail estimates; the selection
view manages named products across pages, default markup and individual overrides.
Review shows the immutable exact-variant CAD snapshot before explicit confirmation.
Imports provides progress, product-level results and safe retry; inventory exposes
stock-only opt-in controls with searchable, readable sync states.
**Save changes** persists selection and pricing without creating a preview or job.
Validation failures retain the working draft without changing saved configuration.
Shared route state and versioned per-shop `sessionStorage` preserve unfinished
selection, markup edits and browsing context across views and tab reloads. Stored
drafts contain public product metadata, not embedded authentication parameters, and
are rejected when their saved-pricing baseline no longer matches the server.
Existing `/app/imports` bookmarks redirect to `/app` with their job and embedded
authentication query context retained; legacy preview/queue/retry forms remain
supported. The earlier unified-page design was deployed as release `f986174`;
the task-oriented redesign requires the normal integration-lab release process.

The feed-selection catalog rows show the first supplier product image as a
48-pixel thumbnail. Hover, focus with the keyboard, or tap/click the thumbnail
to open a larger preview. The preview appears above the table's scroll container
and stays within the app viewport; Escape, clicking outside, scrolling or resizing
closes it. Missing or failed images display an explicit placeholder. The images
come from the existing feed, without fetching or changing Shopify products.
Protected development upload URLs are mapped to the matching public UltraLove
upload URLs, as in the existing import payload builder. Cloudinary and other
image URLs are left unchanged.
Image previews do not select products or submit forms.

The deployed pricing/import increment adds immutable CAD previews and background
draft-import jobs. Opt-in inventory synchronization is deployed to the integration
lab as release `107030b`; enrollment remains off until explicitly enabled.
The existing
feed and root-only PHP workers remain in `craigpestell/ultralove`; this web
process must never run those workers as root or read their credential files.
No order forwarding, payment processing, emails or shipments are enabled by the
app. The deployed import-visibility increment adds opt-in Active status and Online
Store publication for newly imported products. The additional publication scopes
are authorized for the existing lab installation.

## Pricing and product-import jobs

In **Catalog**, select 1–50 parents, then open **Selection & pricing** and set the
**Default retail markup** between 0 and 1000 percent, with at most two decimal
places. The default applies to every
selected parent unless its **Markup override** is set; a parent's override
applies to all its variants. Changing the default preserves overrides.
Leave an override blank to use the default, or choose **Use default for all
products** to explicitly remove every override (including off-page products).
Under **Reset**, **Restore saved selection and markup** discards working pricing and
selection edits. Off-page selections remain editable/removable when filtering
or paginating, and same-page navigation preserves unsaved settings.

Choose **Save changes** to save without importing, or **Create pricing preview**
to atomically save and open an immutable snapshot in **Review import**. A failed preview
does not replace the saved configuration. Default and overrides receive the
same server-side validation. The preview uses the
existing supplier payload builder, including published variants, barcodes,
approved public media and explicit stock/data-review warnings. Retail prices
are supplier prices multiplied by `(1 + markup / 100)`, rounded to two decimals.
Override prices use exact decimal half-up rounding. No FX conversion, shipping,
tax or fee adjustment is applied. Default and per-parent markup values are
persisted with the snapshot, and the background worker consumes its frozen
variant prices rather than recomputing them from later edits.

The **Set new products to Active** and **Publish new products to Online Store**
switches both default off. Publishing requires Active status; turning Active
off also clears publishing. The three modes are:

- Both off: create unpublished drafts, preserving the existing default.
- Active only: activate new products without requesting any channel publication.
- Active and publish: activate new products and publish to the Online Store only.
  Other sales channels are not targeted.

The visibility settings and exact Online Store publication ID are saved with
the immutable pricing preview. Changing the switches does not alter an existing
job; create a new preview to change its settings. Review stock/data warnings
before confirming. Activation and publication apply only to products created by
that job, never to reused listings from prior imports.

Confirm the displayed snapshot and choose **Queue import** within ten
minutes. The server verifies that saved selections still match the preview.
The interface requires a fresh preview when working selection or pricing
differs from its snapshot; editing visibility never changes a saved snapshot.
Only one job per store can be queued/running. A separate non-root systemd worker
processes it; public HTTP handlers never execute a root importer.
Status refreshes automatically and shows per-product results and Shopify links.
Failed jobs can be retried/reconciled on the same page using their original
snapshot, not the current working settings.
Existing canonical app-owned listings are reused without any mutation,
including their retailer-edited prices, content, inventory and publication state.
The importer no longer reuses or requires the old `ultralove-dev-*` test fixtures.
Existing claims pointing to those fixtures still require the operator cutover
described below; they are not silently reassigned.

New copies initially become unpublished drafts at the verified merchant **Shop location** in
the CAD lab store. Unsafe/unknown/shared stock stays zero with review warnings,
as in the existing payload policy. New source variants, SKU, price, barcode,
inventory policy and stock are verified before activation or publication.
Draft-only and Active-only jobs can finish while images are processing. Publishing
requires all expected product images to be READY; missing, processing or failed
images leave that item failed for explicit review and retry, without publishing.
The worker confirms Active status and Online Store publication before recording
success. A later failure may leave an already-created product Active but not
published; the per-item error explains the remaining action. Its Shopify product
link is recorded before activation/publication, so failed items can be reviewed.
Importing does not automatically enroll products in ongoing sync or approve
order forwarding.

The persistent database stores the immutable feed generation/cursor, selection,
markup, visibility settings, payloads, per-product results and cross-job creation claims. Before the
only create mutation, the worker records a claim and disables API transport
retries. **Retry / reconcile failed items** skips completed items and reads
Shopify to recover a matching owned draft or Active product. An interrupted
activation is reconciled without recreating the product. Publication is checked
before retrying, so already-published products are not published again.
An unresolved uncertain creation or
removed mapped listing blocks another creation and requires operator review.
The worker resumes interrupted jobs after restart. Do not run the standalone
operator catalog importer concurrently with these jobs.

`ops/provision-lab.sh` backs up the persistent database to a root-only directory
before migrations, builds the worker, and installs `ultralove-shopify-imports`.
The existing Shopify Supplier plugin is still needed for feed-client and payload
planning code. The proxy's `import-plan` operation only reads/plans; all Shopify
mutations run in the separate app worker.

## Opt-in inventory synchronization

Open **Manage inventory sync** from the catalog page (`/app/inventory`).
Only products with a completed app import and a persisted creation claim appear.
Confirm inventory-only synchronization separately for each product, then choose
**Enable inventory sync**. Enrollment validates the canonical product identity,
supplier variant metadata, tracked inventory and the approved **Shop location**.
The source variant, Shopify variant and inventory-item mappings persist in SQLite.
Legacy test fixtures cannot enroll.

The existing singleton non-root import worker also processes inventory cycles.
Imports take priority; enabled products target a five-minute interval, not a
guaranteed service level. **Sync now** schedules a cycle; **Pause sync** prevents
new corrections after the worker rechecks enrollment. A request already sent
to Shopify can finish. Changing catalog selections does not pause enrollment.
The page refreshes while products are enabled and displays last success, next
due time, mapped variant count and explicit errors/review warnings.

Corrections set **on-hand** supplier stock using compare-and-set, preserving
Shopify committed order reservations rather than resetting available stock.
Unknown, unmanaged, shared, out-of-stock, missing or withdrawn supplier stock
becomes zero. Missing mapped variants are not deleted, and new supplier variants
require separate review/import. Stock below committed orders produces a review
warning. Prices, descriptions, product status/publication and orders are untouched.
This is not dropshipping enrollment or an order-forwarding implementation.

Each cycle validates/advances the supplier journal and reads a current bounded
stock snapshot. Expired cursors/generation changes require a verified resnapshot.
Checkpoints advance only after all corrections and final Shopify verification.
Each mutation has at most 250 quantities; products have at most 2048 variants.
Pending input, idempotency key and timestamp are saved before sending. A lost
response or restart retries the identical correction; a confirmed rejection
allows a fresh compare-and-set next cycle. Uncertain requests older than Shopify's
24-hour idempotency window pause for explicit stock review and re-enrollment.
Supplier rate-limit responses delay scheduling by at least their `Retry-After`.
Other failures remain visible and retry on the next scheduled cycle.

### Deployment and legacy lab cutover

Local tests do not deploy or enable this feature. Deploy the supplier feed client
with its new `inventory_state()` method to **development only**, then install the
updated restricted catalog proxy. Its existing pinned SSH connection and feed
authentication remain required; do not bypass Cloudflare Access.
Apply the additive `20261009200000_inventory_sync` migration before starting
the updated app/worker. No new Shopify scopes are required.
All imports remain unenrolled until explicitly enabled.

Before replacing old test products, back up the development connector settings,
its cron file and the app SQLite database. Disable the old supplier connector
and `/etc/cron.d/ultralove-shopify-dev`, and wait for its exclusive worker lock
to be released. Remove only proven old `ultralove-dev-*` lab fixtures and their
matching app claims/results, then create fresh canonical app imports. Do not
delete canonical app-owned mappings or run both connectors against a product.
The old cron/settings/Shopify fixtures have **not** been retired by local tests.
The supplier plugin remains needed for feed-client and payload code; this is
not authorization to enable production synchronization or forward orders.

### Enabling publication on an existing installation

Publication discovery and publishing require `read_publications` and
`write_publications`, in addition to the existing product/inventory scopes.
The example environment, app configuration and fresh-host provisioning include
both. Existing protected app environment files are deliberately not overwritten
by provisioning: append both scopes to the existing `SCOPES` value without
removing current permissions. Update the installed Shopify app's configured
scopes, obtain merchant authorization, reopen the embedded app, then restart the
app/worker with the updated environment. Never print or commit the environment.
Missing permissions produce an explicit preview/worker error, not a draft-shaped
success fallback. Publication lookup identifies Online Store through its
associated Shopify app, not the catalog's auto-generated display title. It must
find exactly one publication and never guesses another channel if the Online
Store is missing or ambiguous.

Run the additive `20261009190000_import_visibility` migration before starting
the updated app/worker. Existing preview and historical jobs migrate to
draft-only settings (`active=false`, no publication ID). Code rollback cannot
undo activation or publication already performed in Shopify.

Local verification covers all three modes, migrated draft-only jobs, immutable
mode confirmation, saved product links, image readiness and interrupted
publication recovery. Browser checks cover default-off switches, publishing's
Active dependency and submitted form values. No real product was activated or
published during these checks.

## Local validation

### UX ownership

Select **Shopify UX** in VS Code's Chat agent picker with this repository open.
The project-specific agent is defined in
[shopify-ux.agent.md](.github/agents/shopify-ux.agent.md) and can also be delegated
merchant UX tasks by other agents. It owns catalog selection, pricing previews,
import feedback, accessibility, and responsive embedded layouts; it implements
and verifies focused improvements rather than only suggesting a redesign.
Choose the app structure from merchant tasks and usability evidence, without
any preference for a particular number of pages.
Use the owner's authenticated Chrome session for live inspection when the
integrated browser cannot log in. Bounded lab saves, previews, queued imports,
and inventory-control tests are authorized; record persisted changes, restore
reversible settings, and prefer unpublished drafts. This does not authorize
production changes, destructive cleanup, or publication solely for testing.

The project includes two complementary skills:

- [Web Design Guidelines](.agents/skills/web-design-guidelines/SKILL.md), from
  Vercel, for interaction and accessibility reviews.
- [Frontend Design](.agents/skills/frontend-design/SKILL.md), from Anthropic,
  for intentional hierarchy, layout, and copy, subordinate to native Shopify
  Polaris conventions.

The agent also uses the existing Shopify AI Toolkit required by `AGENTS.md`.
Toolkit helpers must run with `OPT_OUT_INSTRUMENTATION=true`; app code and
merchant data must not be sent as telemetry.
Skill sources are recorded in `skills-lock.json`. To restore the project skills,
run `npx skills experimental_install`.

Example task: "Improve the catalog-to-import journey. Identify the highest-impact
merchant friction, implement a focused set of improvements, and verify the
selection, preview, and import-feedback states without mutating a live store."
Selecting the agent assigns a role for that session; it is not an autonomous
background service. Deployment and live-store mutations require separate
authorization.

### Commands

Use Node 24 and npm:

```sh
npm ci
export DATABASE_URL=file:dev.sqlite
npm run prisma -- generate
npm run check
```

Checks include offline lab-policy tests, TypeScript, ESLint and the production
build. These do not establish live Shopify authentication or feed connectivity.
For a configured local session and selection database, run `npm run setup`.

The additive `20261009203000_product_markups` migration must precede the updated
app/worker. Saved defaults initialize to `0.00`; empty override maps preserve
historical global-only jobs and their existing payloads. No live migration is
performed by local validation.

For a safe browser walkthrough, run `node tests/fixtures/unified-import.mjs` and
open the localhost URL it prints. It uses the real workspace provider, catalog,
selection, review/results and inventory routes/components with synthetic
authentication, feed, persistence, queue, results and inventory enrollment. It cannot call
Shopify or write the live store/database. Queueing deliberately produces a mock
failure; retry demonstrates reconciliation/completion. This fixture tests UI
behavior, not real embedded authentication, feed or worker connectivity.

Prisma and `@prisma/client` stay on the supported 6.19 line (minimum 6.19.3).
The official Shopify Prisma session adapter currently requires Prisma 6; a
Prisma 7 migration must wait for compatible session storage rather than bypassing
npm peer validation.

Unused GraphQL demo/code-generation dependencies are omitted. Prisma's config
dependency uses a scoped `deepmerge-ts` 8 override for its recursion advisory;
Prisma generation, schema validation and migrations must pass with that override.

### Verification recorded, 2026-10-09

- Twenty-three offline authentication/catalog/import and SQLite queue tests passed; type-check, lint and
  production build passed.
- Prisma generation, schema validation and SQLite migrations passed.
- `npm audit` reported zero vulnerabilities, including development dependencies.
- The production build served its landing page over local HTTP with dummy
  credentials. Foreign-store app/login requests returned 403, duplicate shop
  parameters returned 400, and an invalid-signature webhook returned 401.
- Live Shopify session authentication, embedded rendering and hosted feed access
  passed on release `05f1160`.
- The live browser displayed 50 parents, advanced to another page and returned
  one product for SKU `1513`. Category `518` combined with that SKU also returned
  one product. Category labels decode entities as text, including
  `Lotions, Creams & Dusts`; the exact accessible label is `Category`.
- Saving selections persisted across reloads. Exactly 50 parents could be saved;
  all product checkboxes on the next page were disabled at the limit, and a
  forged 51-parent submission produced a visible rejection.
- Clear selection reset the unsaved selection to `[]`. The original five saved
  selections were restored after the import checks below.
- Pricing/import release `13306ab` passed live embedded preview, confirmation,
  queueing and results checks. A 25% job reused all five existing selections
  without changing their prices, content, publication state or inventory.
- Source parent `17539` (SKU `SE1414-50 BX`) created unpublished Shopify draft
  `8424579366975`: CAD 7.95 wholesale became CAD 9.94 at 25% markup, with stock 2,
  barcode `716770016270` and one READY media item. Native Shopify admin confirmed
  Draft status and no publication to any channel.
- A second job previewed 30% but reused that draft without repricing it or
  creating a duplicate. An interrupted-job simulation retained its creation
  claim; worker restart recovered the same draft through read-only reconciliation.
  Exactly one listing existed for that source, and all three jobs completed.
  The draft and job history remain intentionally available for staff review.
- Deployed foreign-shop requests returned 403, invalid-signature webhooks returned
  401, and responses carried `Cache-Control: no-store`. App, Nginx and lab PHP-FPM
  were active; the app listener remained loopback-only.
- The original dev worker still synced SKUs `1513`, `2455` and `70072`, preserving
  retailer prices. These checks do not establish independent-store onboarding or
  real-order fulfilment.

### Page select-all verification, 2026-10-09

Release `3136d22` passed all 24 tests, type-check, lint and app/worker builds
locally, during lab provisioning and in GitHub CI. Live embedded checks confirmed
that all 50 visible checkboxes are selected, partial selection is reflected in the
header, and deselecting the header clears only that page. Choices from other pages
remain selected; the total-limit explanation appears when another full page cannot
fit. Filtered-page selection/deselection preserves off-page choices, and an empty
page disables the control. No save or import was triggered during these checks;
the original five saved selections remained unchanged.

### Image and import-visibility deployment, 2026-10-09

Release `5b200e9` includes catalog thumbnails/hover previews, opt-in Active and
Online Store publication settings, public supplier image URLs, and channel
discovery through AppCatalog app associations rather than generated catalog names.
All 39 tests, type-check, lint and app/worker builds passed during provisioning;
the discovery query also passed Shopify 2026-10 schema validation.

Live embedded verification confirmed a 48-pixel thumbnail loads an 800-by-800
public supplier image and opens a 280-by-280 hover preview within the iframe
viewport. A fresh Active + Online Store pricing preview succeeded and persisted
the correct publication ID with explicit mode-specific confirmation. It remained
unqueued: no product was activated or published during these deployment checks.
Saved IDs `17186,17188,17535,17537` were preserved; existing completed jobs retained
draft-only settings. No jobs were queued or running after verification.

The additive visibility migration is applied. App, import worker and Nginx are
active; HTTPS readiness and Nginx configuration checks passed. That deployment's
protected SQLite backup is `20261009T193644513635Z.sqlite`; the runtime environment backup is
`app-env-20261009T192535003749Z.bak`. The previous code release is `c930575`.
These changes were committed locally and deployed from exact git archives; no
GitHub push was performed as part of this deployment.

### Save-and-continue deployment, 2026-10-09

Release `90720c0` replaces the catalog save button with **Save selection and review
pricing**. It validates and persists the selection before redirecting to
`/app/imports`; form/feed failures remain on the catalog page, and persistence
failures cannot produce a successful redirect. Empty selections can still be
saved to clear previously saved choices.

All 40 tests, type-check, lint and app/worker builds passed during provisioning.
Live embedded verification preserved the then-current saved IDs
`17186,17188,17539`, confirmed the database save timestamp advanced, and landed on
**Pricing and product imports** with those same IDs. No preview or import was
created: the job count remained 11, with none queued or running. App, import
worker and Nginx remained active. The protected SQLite deployment backup is
`20261009T194530655109Z.sqlite`; the previous code release is `5b200e9`.

### Unified pricing and import deployment, 2026-10-09

Release `f986174` deploys the catalog, default/per-product markup, preview,
confirmation, and import results workspace. The additive
`20261009203000_product_markups` migration preserves historical global-only jobs
and initializes saved pricing to zero markup with no overrides.

The exact UX-only source tree passed all 43 tests, TypeScript, ESLint, and
app/worker builds both locally and during lab provisioning. Unrelated
inventory-sync and WordPress changes were excluded from this commit and
deployment and remain in their original worktrees.

Offline browser checks exercised bulk/default/individual markup, filtering,
immutable previews, confirmation, failed-job reconciliation, keyboard scrolling,
and a 390-pixel viewport. The available live browser required Shopify login, so
post-deployment authenticated embedded rendering remains unverified.
HTTPS returned 200, foreign-shop requests returned 403, and the app, import
worker, and Nginx were active. Saved IDs `17186,17188,17539` and the 11 existing
jobs were preserved; none were queued or running. No product was imported,
activated, or published during this deployment.

The pre-migration protected SQLite backup is
`20261009T203756676353Z.sqlite`. The previous code release is `90720c0`;
the `previous` symlink retains that rollback target.

## Existing Shopify app

Verified in the Dev Dashboard on 2026-10-09:

- Organization: `239653376`; app: `433204330497`.
- Active version: `ultralove-lab-catalog-visibility`.
- Current URL: `https://shopify-lab.104-248-211-144.sslip.io`.
- Current embedding setting: `true`.
- Allowed redirect: `https://shopify-lab.104-248-211-144.sslip.io/auth/callback`.
- API version: `2026-10`.
- Existing scopes are retained in the unlinked `shopify.app.toml`.

This repository does **not** create another Shopify app. The empty client ID
intentionally prevents treating the template as a linked/deployable app.
Use Shopify CLI to link to the existing app after the hosting/authentication
design is verified; never select creation of a new app. Do not run `app dev`
with automatic URL updates or deploy a configuration over the installed app
without reviewing the resulting configuration and preserving its current
permissions and client-credentials worker access.

Copy `.env.example` to an untracked `.env` and provision the existing app's key,
secret and approved HTTPS URL securely. Do not use a manager's feed password,
commit credentials, print `shopify app env show`, or expose them to the browser.

## Hosting and reprovisioning checks

The existing isolated DigitalOcean integration-lab droplet hosts the app under
a separate non-root service and app directory, not inside WordPress. Capacity
was checked before deployment; no new hosting purchase was needed.
This app can move to another Node/container host.

When reprovisioning or moving the installed app:

1. Confirm host capacity, persistent session storage, backups and an isolated
   service account. Keep session data and app credentials outside the webroot;
   persist the SQLite database across deploys. The Docker image includes the
   Prisma CLI for migrations; it is not a complete deployment configuration.
   Set `DATABASE_URL` to an absolute SQLite file on the protected persistent
   volume, not the example's relative development path.
2. Establish HTTPS and reverse proxying with no HTML/session CDN caching.
   Shopify must be able to embed the interface; do not put an interactive
   Cloudflare Access login in its iframe or weaken protection on the dev feed.
3. Validate the official SDK authentication flow for this own-organization app,
   its redirect URLs, signed webhooks and iframe headers. Session-token/OAuth
   authentication for the UI is distinct from the existing worker's
   client-credentials grant; worker success does not prove UI authentication.
4. Arrange a dedicated server-side catalog credential and approved restricted
   transport from this host. Do not expose feed credentials or bypass dev's Access
   policy. Do not copy the root-only importer behind a public HTTP endpoint.
5. Test login from Shopify and rejection of other shops. Preserve the existing
   worker and verify it after publishing a reviewed app version with the new
   URL and embedding enabled.

The foundation's hosting, authentication and iframe checks passed on 2026-10-09;
the existing dev worker also completed a product-only sync with its original
selection and preserved retailer prices. The current installed version preserves
that foundation configuration and adds merchant-authorized publication scopes.

## Live catalog connection

The browser uses a separate SSH key with a forced PHP command,
restricted to the app host's public IP. It permits only catalog reads through
the existing authenticated loopback HTTP feed. Normal authentication and feed
bookkeeping may write to the database, as approved on 2026-10-09; the connection
does not create/change supplier products or forward orders.
It does not provide shell, forwarding or administrator
access, and does not change Cloudflare Access or either firewall.

The dev account is the existing catalog-only customer with a separate,
revocable application password. Neither private key nor password belongs in git.
The proxy credentials, source restriction and pinned host key are provisioned.
The verified dev SSH target is `138.68.43.251`, hostname
`ultralove-dev-managed`; do not use the historical `138.197.211.58` address.
The app runs as a separate service user and connects as `ultralove-catalog-proxy`.
The forced command accepts only `catalog-read`; an attempted `id` was rejected.
Provisioning sources are in `ops/provision-app-catalog.sh`,
`ops/provision-catalog-proxy.sh`, `ops/setup-catalog-proxy.php` and
`ops/catalog-proxy.php`.

This connection deliberately does not request the optional strict database
read mode used by the earlier standalone import verifier. The existing guard
is unchanged. Inventory synchronization requires the development supplier
feed-client update deployed as `618a71a`; the original browsing adapter did not
require a WordPress runtime code deployment.

The app source is published in the private GitHub repository. Its `main` branch
contains the approved catalog/hosting, pricing/import and page-selection work.
The stacked feature PRs were integrated in dependency order, with checks passing
before each merge. Dependency updates are validated against the integrated app
and worker rather than only the foundation. Source merges do not deploy changes:
the running release below was deployed from a git archive independently.
Production rollout and independent retailer onboarding require separate work
and approval.

## Current host and rollback

The deployed release is `107030b` on the isolated integration-lab
droplet. Node 24.21.0 runs as `ultralove-shopify` on `127.0.0.1:3097`,
proxied by its separate HTTPS Nginx vhost. Source is under
`/srv/ultralove-shopify/releases`; `current` selects the release.
Sessions are in `/var/lib/ultralove-shopify/sessions.sqlite` (mode 0600).
The app environment is root-readable only at `/etc/ultralove-shopify/app.env`.
Request logging omits query parameters. The development supplier feed client
is deployed as `618a71a`; production WordPress is untouched.
The separate `ultralove-shopify-imports` service runs as the same non-root user,
with a singleton worker lock. Persistent jobs, creation claims and inventory
enrollment/checkpoints share the
session database; pre-migration backups are root-only under
`/srv/ultralove-shopify/backups`.

### Inventory deployment verification, 2026-10-09

- App code commit/release `107030bcd7f7824095d9140dd305fe186c94ba7d`;
  supplier commit `618a71a`, published on the dedicated
  `feat/shopify-inventory-sync` branch for the normal development deploy.
  App code was deployed from an exact git archive without pushing app `main`.
- The supplier deployment found no drift and changed only its feed-client PHP
  file. Server syntax checks passed, PHP-FPM restarted, and all four development
  smoke-test URLs returned 200. The restricted proxy matched its previous source
  before replacement; its root-only rollback copy is
  `/root/ultralove-catalog-proxy-before-107030b.php`. Credentials, pinned host key,
  Cloudflare Access and firewall policy were unchanged.
- The additive inventory migration applied successfully. All 50 app tests,
  type-check, lint and app/worker builds passed during provisioning.
  The pre-migration database backup is `20261009T204650280657Z.sqlite`.
  App, import/inventory worker and Nginx are active; HTTPS readiness passed.
- Real authenticated inventory reads for source `17539` returned one variant.
  A subsequent checkpoint read retained the same generation and cursor `9027`
  with `resynced:false`. This verified the new supplier-client/proxy/SSH path.
- The authenticated inventory page loaded inside Shopify Admin without console
  errors and displayed imported-product rows with confirmation checkboxes and
  **Enable inventory sync** controls.
- The persistent inventory table contains zero enrollments; there are no queued
  or running imports. No live stock correction was sent by this deployment.
  Mutation/reservation/retry behavior is covered by the offline persistent tests,
  not claimed as a live stock-write verification.
- The old development connector/cron and legacy Shopify fixtures remain intact;
  they were not retired or deleted during this deploy. Canonical app imports
  can enroll independently, but old fixtures still require the cutover above.
  Production and order-forwarding settings were not changed.

The pre-update Shopify version `ultralove-dropshipping-lab-2` remains available
for rollback: restore it in the Dev Dashboard to return to the old supplier-lab
URL and non-embedded mode. Do not uninstall/recreate the app or rotate its secret.
Before returning to any pre-jobs code release or the old non-embedded app version,
run `systemctl disable --now ultralove-shopify-imports` on the lab host so imports
cannot continue behind an older UI. Keep the database, creation claims, backups
and additive migrations intact. The verified catalog release `05f1160` is the
pre-jobs code rollback.
The preceding local hosting release `a419640` failed due to file read permissions
and is **not** a usable code rollback. The verified foundation `a271a77` remains
an earlier code rollback, but does not provide catalog browsing. Code rollback
does not undo persistent session, selection or import migrations.
