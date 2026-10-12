# UltraLove Shopify app

Separate web interface for the existing **UltraLove Catalog** app (formerly
**UltraLove Dropshipping Lab**),
scaffolded from Shopify's MIT-licensed React Router template. The upstream
license remains in [LICENSE.md](LICENSE.md).

For a client-facing overview, login instructions and demonstration walkthrough,
see [the client guide](CLIENT-GUIDE.md). Arrange client store access separately;
the guide intentionally contains no passwords or private credentials.

## Status

### Deleted Shopify listings

Inventory keeps deleted-listing history in a **Deleted / archived** view rather
than displaying it as current stock. A retained `ImportClaim.deletedAt` timestamp
stops supplier sync, excludes the listing from current counts and bulk enrollment,
and preserves import history, creation guards and uncertain stock corrections.
Recovery creates a separately confirmed preview for a new unpublished draft or
an explicitly connected existing listing. Supplier sync remains opt-in afterward.

Deploy migration `20261012034000_deleted_listings` with the app and worker.
Deploy/register the `products/delete` subscription in `shopify.app.toml`, or
register its shop-specific callback through the Admin API, to enable prompt signed
deletion notifications. The worker also checks all current mapped
listings, including catalog-only and unenrolled products, about every five minutes
in batches of at most 50 IDs. This backfills deletions predating the webhook.
GraphQL errors, transport failures and malformed/partial responses never mark
listings deleted. Failed verification is logged and retried after five minutes.
Deploying app code alone does not register an app-configuration subscription;
verify the deletion callback separately as part of rollout.

The embedded catalog browser and saved selections are deployed and connected
to the real development feed.
The interface accepts only
`ultralove-integration-lab.myshopify.com`. Shopify authentication and signed
webhook verification use the official SDK. Lab-store checks additionally apply
to login, authenticated routes and webhook handlers. The template's product
creation demo has been removed.

The browser provides name/SKU search, category navigation, bounded
50-parent pages and per-store saved selections without a product-count cap. Saving
does not import, publish, sync inventory or approve forwarding. It validates
published selections against the real feed before committing app-owned SQLite
state; no WordPress product mappings or settings are changed.
The table's **Select all on this page** checkbox selects or deselects only the
visible page, preserving choices on other pages. It shows a partial state when
some rows are selected. Selections accumulate across pages without disabling
products or page selection at a 50-parent total.
Bulk selection changes the working selection only. The merchant workspace separates
**Catalog**, **Selection & pricing**, **Review import**, **Imports**, and **Inventory**
by task. The catalog heading is **UltraLove's catalog** and numeric availability
is shown as **N units**, representing UltraLove stock rather than Shopify inventory.
Variant, unmanaged, unknown/shared and out-of-stock labels remain distinct.
Catalog rows pair wholesale prices with retail estimates; the selection
view shows 25 products per page, with case-insensitive search across the full
selection by decoded product name, SKU or supplier ID. Search, page and individual
markup edits survive navigation and tab reloads. Clear search never removes
products; save/preview, default-markup reset and **Remove all selected** apply to
the entire selection, not just visible matches.
Fresh sessions progressively load missing public product details in batches of
at most 50 through the authenticated, no-store `/app/selection-details` resource.
Loading and failures explicitly explain incomplete name/SKU search; supplier-ID
search and pricing edits remain available, and **Retry details** resumes loading
without discarding the draft. Details failures never count as successful imports.
The restricted supplier proxy's existing `selection` operation now returns public
parent summaries alongside its unchanged ID list. Deploy the matching
`ops/catalog-proxy.php` to the dev supplier's existing
`/usr/local/libexec/ultralove-catalog-proxy.php` before the app release, retaining
its forced-command/key restrictions and backing up the previous proxy. An older
proxy response is rejected explicitly; this requires no WordPress plugin, feed
permission, Shopify scope or database-schema change.
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
supported. The task-oriented redesign, with uncapped product selections and
reviewed existing-listing updates/recovery, is deployed to the integration lab
as release `6630e89`, including selection/review search and pagination,
HTML-normalized update verification and asynchronous image-readiness waiting
before publication, plus missing-listing inventory pause and verified stock
correction recovery.

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

### Fulfillment choices

New selections default to **Catalog only — my own stock**. Choose
**How will you fulfill these products?** to apply a mode to the whole selected
batch, or override individual products beside their markup. Choices persist
with the selection and immutable review; confirmation covers every product's
mode. Changing working choices does not change existing Shopify stock or sync.

- **Catalog only:** import content, variants, SKUs and reviewed prices without
  `inventoryQuantities`. Tracking stays on and overselling is denied; Shopify
  stock is empty/zero until the retailer sets their own quantities. New products
  default to drafts. Supplier inventory enrollment, bulk enrollment and
  scheduled corrections are blocked for these products.
- **Dropshipping:** import supplier availability. Inventory sync still needs
  explicit enrollment after import. This choice does not grant dropshipping
  approval or enable order forwarding. Approval and fulfillment activation
  remain separate; the lab app still has no order-forwarding feature.

Existing import snapshots and claims migrate as dropshipping to preserve their
current payloads and opt-in sync. Existing enrollments, quantities and publication
are not changed by deployment. Switching an imported product's mode requires a
new confirmed review; pause sync and reconcile pending corrections first.
Switching modes never changes existing stock automatically.
The additive `20261012030000_fulfillment_modes` migration must run before the new
app and worker. The Shopify Apps-list name is separate platform configuration:
changing this web UI alone does not rename the installed app.
The existing app's name-only configuration version `ultralove-catalog-name`
(`1163369840641`) is active, and **UltraLove Catalog** is verified in the
integration lab's installed Apps list. The app ID, existing installation,
permissions, embedded URL and redirects are unchanged. The old URL handle
`ultralove-dropshipping-lab` is intentionally retained.

### Verified integration-lab rollout

Fulfillment modes are deployed as release
`a52a5d15d580b251eb340ba59d7e654233b672e1`. A protected SQLite backup preceded
the additive migration. All 75 tests, TypeScript, ESLint, app/worker builds,
Nginx validation and HTTPS readiness passed on the lab host.

The pre/post-deploy comparison preserved the 126-product saved selection,
pricing, job counts, all 227 claims, all 112 inventory enrollments and all
110 enabled enrollments. Historical items and claims remain dropshipping.
Authenticated browser checks verified the new catalog-only default, applying
dropshipping to the selection, per-product mixed choices and existing inventory
labels; the working choices were restored without saving changes.
Offline browser checks also verified frozen mixed-mode reviews, stale-choice
confirmation blocking and catalog-only inventory rows without enrollment controls.

Read-only live supplier plans for products `18704`, `25779`, `17186` and `23742`
passed both mode validators: catalog payloads omit every supplier quantity,
retain tracking and deny overselling; dropshipping quantities remain intact.
The approved title stripping remains visible in those plans. No Shopify product
creation, inventory change, fulfillment conversion or publication was performed
for rollout verification; creation behavior is covered by the mocked API/SQLite
integration tests.

The existing saved selection contains supplier product `68951`, now `pending`
rather than published. Its selected-detail batch fails explicitly and retains
the selection. Remove or republish this product before previewing the entire
saved batch; deployment deliberately does not alter supplier publication or
discard saved selections. The other selected-detail batches load normally.
The restricted supplier proxy reports this known rejection using the bounded
`409 / SELECTED_PRODUCT_UNAVAILABLE` envelope, not arbitrary exception text.
The app explains that a selected product or variant is no longer published or
available instead of presenting it as a temporary connection outage.
Genuine transport failures and the existing bounded rate-limit handling remain
unchanged; no partial selection or import data is accepted.
This error-message fix is deployed as lab release `5fbb5cb`. Read-only live
checks verified valid product details and the corrected rejection through
details, selection validation and import planning. The supplier proxy's protected
rollback copy is `/var/backups/ultralove-catalog-proxy.before-5fbb5cb.php` on dev.

Polaris validation passed for the catalog, review and recovery components.
The inventory route's standalone toolkit validator cannot resolve the existing
server SDK import; repository typecheck/build and rendered inventory browser
checks passed. No server imports were changed to accommodate that tool limitation.

In **Catalog**, select one or more parents, then open **Selection & pricing** and set the
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

There is no app-level product-count limit on saved selections, overrides, or
import jobs. Supplier validation and planning still use sequential requests of
at most 50 parents to respect the existing feed/SSH transport bounds. All plan
batches must have the same feed generation and nondecreasing cursors; a failed
or inconsistent batch leaves the saved configuration and job history unchanged.
Catalog pages remain bounded at 50 products. Large selections still depend on
request-size, browser storage, feed rate limits, and preview freshness; explicit
errors must not be treated as a successful partial import.

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
The interface requires a fresh preview when working selection, pricing, visibility,
or existing-product update choices differ from its snapshot.
Only one job per store can be queued/running. A separate non-root systemd worker
processes it; public HTTP handlers never execute a root importer.
Status refreshes automatically and shows per-product results and Shopify links.
Failed jobs can be retried/reconciled on the same page using their original
snapshot, not the current working settings.
Pricing snapshots and import results show 25 products per page, with name,
SKU and supplier-ID search. Confirmation and **Retry unfinished items** appear
above the table and apply to the entire immutable snapshot, not the visible
page or search results. Completed products are skipped during retry.
By default, existing recognized listings are kept without any mutation,
including their retailer-edited prices, content, inventory and publication state.
The importer no longer reuses or requires the old `ultralove-dev-*` test fixtures.
Legacy listing connections require explicit review; they are never silently
reassigned.

### Updating and connecting existing Shopify products

In **Selection & pricing**, **Existing Shopify products** defaults to **Keep
unchanged**. Choose **Update from UltraLove** and explicitly select:

- **Product name, description, and vendor**.
- **Add supplier images**, retaining existing retailer images.
- **Retail prices using the selected markup**, including individual overrides.

Select at least one update field. These choices stay in the browser draft and
are frozen with the preview; **Save changes** still saves selection and pricing,
not an update job. The review shows current and proposed values before separate
confirmation. Updates preserve product and variant IDs, handles, publication,
collections, inventory, and unselected fields. Existing variants must be
unambiguously matched; updates do not blindly replace the variant list.
Shopify responses are validated, and retail comparisons use exact CAD cents.
Large variant sets are read with pagination; price mutations contain at most
250 variants. Updates and links require a fresh snapshot even when retrying.
The worker checks for intervening retailer edits and ownership changes before
continuing, and reconciles durably recorded partial operations rather than
blindly repeating image uploads or creations.
Description verification compares HTML5-parsed structure rather than raw
strings. Equivalent entity encoding, optional closing tags, void-tag syntax
and attribute order do not cause false failures. Added indentation between
children of plain list/table containers is ignored, while text, formatting,
links, images, attributes, inline spacing and preformatted whitespace remain
significant. This comparison also protects partial-operation reconciliation
and intervening retailer edits; it does not rewrite WordPress descriptions.
Unconfirmed updates identify the remaining reviewed fields in the item error.

Under **Connect existing products or recover missing listings**, paste a
Shopify admin product URL, numeric product ID, or Product GID to explicitly
associate an unlinked product. The server verifies the target and its variant
identity before creating a new review. Connecting only authorizes the selected
fields; **Keep unchanged** connects ownership without refreshing product content
or retail prices.
Connection fields also support search and 25-product pages. Edits remain in
the form state when their products are off-page or filtered out. **Validate
connections and create fresh review** appears before the fields and submits
all snapshot products, pricing choices and connection edits.

A previously linked product that is verified missing is automatically proposed
as **Create replacement** in the import review. No separate replacement checkbox
or recovery preview is required. The normal review confirmation authorizes a new
product with the snapshot's prices and new-product visibility. Product and
variant IDs change; previous retailer edits and collection membership are not
restored. Nothing is created while preparing the preview.

Replacement requires a certain saved creation mapping, a successful direct
lookup confirming the old product is absent, and no existing supplier identity
on another listing. The worker rechecks those conditions before creation.
Missing ownership markers, lookup failures, uncertain creations and live
conflicting listings do not authorize replacement. These require reconnection
or reconciliation. Enabled/running inventory sync or pending corrections still
block replacement; pause and reconcile before creating a fresh review. A
verified paused binding is rebound to the replacement and remains paused.
Connecting an existing product instead creates a fresh review using the
snapshot's products and pricing choices, replacing the working selection.
Previously saved previews retain their original actions; create a fresh preview
to use the automatic replacement default.

New copies initially become unpublished drafts at the verified merchant **Shop location** in
the CAD lab store. Unsafe/unknown/shared stock stays zero with review warnings,
as in the existing payload policy. New source variants, SKU, price, barcode,
inventory policy and stock are verified before activation or publication.
Draft-only and Active-only jobs can finish while images are processing. Publishing
requires all expected product images to be READY. New products and replacements
wait for asynchronous image processing with at most 10 readiness reads spaced
2 seconds apart (18 seconds of waiting). After waiting, variant/pricing/inventory
verification runs again before activation/publication. Failed, unexpected or
truncated media stops immediately; missing or still-processing images after the
bounded wait produce distinct retry messages without publishing. The saved new
product identity is retained, so retry finishes that same listing rather than
creating another product.
The worker confirms Active status and Online Store publication before recording
success. A later failure may leave an already-created product Active but not
published; the per-item error explains the remaining action. Its Shopify product
link is recorded before activation/publication, so failed items can be reviewed.
Importing does not automatically enroll products in ongoing sync or approve
order forwarding.

The persistent database stores the immutable feed generation/cursor, selection,
markup, visibility settings, listing-update choices, reviewed changes, payloads,
per-product results and cross-job creation claims. Before the
only create mutation, the worker records a claim and disables API transport
retries. **Retry / reconcile failed items** skips completed items and reads
Shopify to recover a matching owned draft or Active product. An interrupted
activation is reconciled without recreating the product. Publication is checked
before retrying, so already-published products are not published again.
An unresolved uncertain creation blocks another creation and requires manual
review. Missing linked listings require explicit, reviewed connection or
replacement recovery.
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
The pinned Admin API uses `changeFromQuantity` for the compare-and-set input.
Saved corrections retain their internal `compareQuantity` field and are
translated only at the API boundary, preserving their quantities and retry keys.
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
response or restart first checks whether Shopify already has every pending
on-hand quantity. Confirmed quantities clear the pending record without
repeating a stock write; otherwise the identical correction is retried.
A confirmed rejection
allows a fresh compare-and-set next cycle. Uncertain requests older than Shopify's
24-hour idempotency window pause for explicit stock review and re-enrollment.
Supplier rate-limit responses delay scheduling by at least their `Retry-After`.
Other failures remain visible and retry on the next scheduled cycle.
If a successful Shopify lookup returns no linked product, synchronization
instead pauses in **Needs review** with explicit reconnection/replacement
guidance. Mappings, checkpoints and any uncertain stock correction are retained;
no stock write, automatic replacement or re-enrollment is attempted. Create a
fresh import review to recover the listing, reconcile any pending correction,
then explicitly enable inventory sync. Malformed responses and access errors
remain failures, not evidence that a product is missing.

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

### Task-oriented UX deployment, 2026-10-09

Release `779c6ff` separates Catalog, Selection & pricing, immutable Review,
Imports, and Inventory into task-focused views. Shared drafts retain selection,
markup, visibility choices, and browsing context across navigation and tab
reloads. The redesign does not change import, pricing, or inventory policy and
requires no new migration.

All 51 tests, TypeScript, ESLint, and app/worker builds passed locally and during
lab provisioning; GitHub CI also passed for this commit. Authenticated Chrome
baseline inspection informed the design, and offline browser verification
covered the redesigned task flow, retry, expiry, override pruning, and inventory
controls.

Post-deployment authenticated Chrome verification confirmed the real Catalog:
four task-navigation links, 50 products, wholesale/retail estimate columns,
the saved 25% default markup, and sticky selection actions. A CAD $17.65
supplier price displayed a CAD $22.06 retail estimate. Live screenshots are in
the session evidence directory. Verification stopped when the authorized tab
independently navigated through other Shopify views, avoiding interference with
concurrent user interaction. Remaining views and draft persistence were verified
offline, not rechecked live after deployment. No blocking Catalog error was
observed, and no save, import, or inventory action was performed.

HTTPS returned 200, foreign-shop requests returned 403, and the app, import
worker, and Nginx were active. Deployment preserved saved selection `[17537]`,
25% markup without overrides, all 19 jobs, and the empty inventory enrollment.
No imports were queued or running. No store data was modified by the deployment.
The protected SQLite backup is `20261009T220126355823Z.sqlite`; the previous
release and rollback symlink point to `107030b`.

### Uncapped product selections deployment, 2026-10-09

Release `6228e98` removes the total selected-parent and import count limits.
Catalog pagination and supplier requests remain bounded to 50 products per page
or batch; selections and per-product markup overrides can span those batches.
Incomplete batches or inconsistent feed checkpoints fail before preview
persistence. No migration or supplier/WordPress deployment was required.

All 52 tests, TypeScript, ESLint, and app/worker builds passed locally and during
lab provisioning. Offline browser verification covered 55 selected products,
saved individual markup, and a complete preview. Automated tests completed a
125-parent import and validated 1,250 selections and overrides. No live imports
were created for verification.

HTTPS returned 200, and the app, import worker, and Nginx were active. Deployment
preserved all 21 jobs, seven saved products, the 25% default markup, the 40%
override for product 17537, and empty inventory enrollment. No jobs were queued
or running. The protected SQLite backup is `20261009T221733675607Z.sqlite`;
the previous release and rollback symlink point to `779c6ff`.

### Reviewed listing updates and recovery deployment, 2026-10-11

Release `65e338820b6704e58ca18c414c00c25fb290b156` adds explicit content,
additive-image and retail-price update choices, reviewed existing-product
connections, and deliberate replacement recovery. Existing listings remain
unchanged by default; missing listings still require explicit recovery.
The exact pushed git archive was deployed through `ops/provision-lab.sh`.
No Shopify app configuration, supplier/WordPress code, or production deployment
was changed.

All 65 tests, TypeScript, ESLint, and app/worker builds passed locally and during
lab provisioning. The published release's GitHub App checks also passed.
Automated coverage includes persisted approvals, ownership and variant matching,
stale reviews, partial operations/retries, uncertain creation, paused inventory
rebindings, exact CAD prices, and 501-variant price updates in 250/250/1 batches.
Prior offline browser verification covered keep/update choices, current/proposed
values, blocking, reconnection and replacement reviews. No live update,
connection or replacement job was queued for deployment verification; actual
Shopify mutations for these paths remain verified with mocks, not a live write.

The additive `20261009220000_listing_policy` migration applied successfully.
All 24 historical jobs retained KEEP defaults and all 407 historical items
retained empty review/work defaults. Comparison with the pre-migration backup
confirmed every existing job, item, creation claim and saved-selection field was
unchanged. The 109 claims and single stored session were preserved. Saved products
remain `[24347,24351,24353,25624]`, with 20% default markup and a 64% override for
product 24351. The two enabled inventory bindings, for suppliers 71955 and 19969,
retained their product/variant mappings, locations, enrollment and revisions;
their ordinary opt-in synchronization remains enabled.

HTTPS returned 200; app, import/inventory worker and Nginx were active, and both
app services run as `ultralove-shopify`. No imports were queued or running.
SQLite integrity and foreign-key checks passed. The protected pre-migration
backup is `20261011T221825110586Z.sqlite` (0600 in a root-only 0700 directory).
The previous release and rollback symlink point to
`6228e989ed0e0c1fb4b9975b1b58dd1158a54316`; code rollback must retain the
persistent database and additive migration.

### Replacement defaults and catalog wording deployment, 2026-10-11

Release `2b80eed72339095ecef8296971c39dfc232aaae1` proposes verified missing
listings as replacements in the normal import review, without an additional
replacement checkbox or recovery preview. Existing and uncertain listings,
failed lookups, and unresolved inventory activity remain guarded. Historical
previews are immutable; create a fresh preview to use the new default.
The catalog heading is now **UltraLove's catalog**, and numeric availability
reads **N units** with unchanged nonnumeric stock states.

The exact local committed git archive was deployed through `ops/provision-lab.sh`.
All 65 tests, type-check, lint, and app/worker builds passed during provisioning;
there were no pending migrations. Prior targeted tests and offline browser checks
verified replacement review/confirmation, reconnection, blocked identity changes,
and catalog wording. No live replacement or update job was queued for verification.
This release and its deployment record were initially committed locally, then
published to `main`. The running SHA is the verified application commit; later
documentation-only commits do not require another deployment or service restart.

HTTPS returned 200 and app, worker, and Nginx were active. Database integrity and
foreign-key checks passed. Backup comparison confirmed all 27 jobs, 428 items,
109 claims and saved selection/pricing fields were unchanged. Saved products
remain `[17539,24382,24388,24480,25624]`, with 20% default markup and no overrides.
Both inventory identities, mappings, locations, enrollments and revisions were
preserved. Before and after deployment, suppliers 71955 and 19969 were enabled
but FAILED with **Invalid inventory response.** This pre-existing inventory
issue remains unresolved; running worker health does not imply successful sync.

The protected database backup is `20261011T224538901621Z.sqlite` (0600).
The previous release and rollback symlink point to
`65e338820b6704e58ca18c414c00c25fb290b156`. Production, supplier code and Shopify
app configuration were untouched.

### Selected-product search and pagination deployment, 2026-10-11

Release `6d4d945e6564a95ab1d09b1626fce3a28acae1ff` adds 25-row selection
pages and full-selection name/SKU/ID search with progressively loaded public
summaries. It was initially committed locally and deployed from that exact
archive; those commits were subsequently published with the image-readiness fix
below.

All 66 tests, typecheck, lint, app/worker builds and Polaris App Home v1
validation passed locally. The provisioner repeated all 66 tests and static/build
checks on the lab; no migrations were pending. The offline browser verified 300
fresh-session selections, off-page name/SKU search, page/override persistence
through reloads, a 300-item pricing preview containing the off-page override,
explicit detail-loading failure/retry without lost edits, and no horizontal
overflow at a 390 CSS-pixel viewport.

The dev supplier's restricted proxy was upgraded first, retaining its existing
forced-command, key and feed permissions. Its previous contents exactly matched
the prior release. A root-only rollback copy is retained at
`/var/backups/ultralove-catalog-proxy.before-selection-search.php`; restore that
only after rolling back the app. The unchanged supplier feed client and all
WordPress web/plugin/theme code remain untouched.

Live read-only checks through the deployed adapter and restricted transport
verified details for all 154 saved selections in batches of 50/50/50/4.
HTTPS returned 200; app, worker and Nginx were active. Unauthenticated detail
requests were rejected without returning supplier data.
SQLite integrity and foreign keys passed; all 28 jobs, 582 items and 109 claims
were preserved exactly, as were selected IDs, default markup, inventory
identities, mappings, locations, enablement and revisions. A normal app POST
saved one retail-markup override during post-deploy verification; its matching
timestamp explains the changed pricing row, and that edit was retained.
The two pre-existing **Invalid inventory response.** failures remain unresolved.

The protected deployment backup is `20261011T230646654301Z.sqlite` (0600).
The preflight comparison snapshot is
`selection-baseline-20261011T230516Z.sqlite` (0600). The previous app release and
rollback symlink point to `2b80eed72339095ecef8296971c39dfc232aaae1`.
Production and Shopify app configuration were not changed, and no live
import/update/replacement jobs were queued by verification.

### Image-readiness waiting deployment, 2026-10-11

Release `155cc24dc13ee4d5db6c0c501457ca5c61483d0c` was committed, pushed and
deployed from that exact archive to the isolated integration lab. This push also
published the preceding selection-search release and its deployment record.
GitHub App checks passed for the release.

Read-only diagnosis sampled two failed replacement items and one failed new
creation. All three already existed as DRAFT products with READY media and no
Shopify media errors: the previous immediate readiness check had rejected
asynchronous processing. The shared new-product/replacement completion path now
waits for up to 10 readiness reads, 2 seconds apart, while retaining the reviewed
product identity, status, image-count and publication checks. Failed or malformed
media still blocks publication, and verification of variants/prices/stock repeats
after waiting. Retrying reconciles the saved draft instead of recreating it.

All 68 tests, typecheck, lint and app/worker builds passed locally and on the
deployment host. Tests cover missing/UPLOADED/PROCESSING-to-READY transitions,
bounded timeouts, distinct failed-media messages, API failures and concurrent
status/price changes without premature publication or duplicate creation.
No migrations were pending.

HTTPS returned 200; app, worker and Nginx were active, and the deployed worker
bundle contains the fix. SQLite integrity and foreign keys passed. All 29 jobs,
736 items, 207 creation claims and saved selection/pricing fields were unchanged,
as were inventory identities, mappings, locations, enablement and revisions.
The 201 historical image-error rows remain until their jobs are explicitly
retried; deployment does not silently clear errors or queue publication.
The two pre-existing **Invalid inventory response.** failures remain unresolved.

The protected database backup is `20261011T232347089609Z.sqlite` (0600).
The preflight snapshot is `image-ready-baseline-20261011T232116Z.sqlite` (0600).
The previous app release and rollback symlink point to
`6d4d945e6564a95ab1d09b1626fce3a28acae1ff`. Production, supplier proxy/feed,
Shopify app configuration and scopes were unchanged. Verification queued no
live imports and performed no product mutations.

### Description verification and paginated review deployment, 2026-10-11

Release `12162e9e3c80a25c9f03dab6d95cd2f866f1b521` was committed, pushed
and deployed from its exact archive to the isolated integration lab. GitHub
App checks passed (run `38186095556`).

Read-only comparison covered all 151 description-verification failures in the
affected UPDATE job. Every raw description differed from Shopify's stored
serialization, but every pair matched after HTML5 parsing, sorted attributes
and removal of non-rendering indentation in plain list/table containers.
Title/vendor comparisons and meaningful text, attributes, formatting, URLs,
inline spacing and preformatted whitespace remain protected. The two separate
Shopify media-processing failures are genuine and were not masked or repaired.
No WordPress description cleanup or supplier/proxy change was made.

Pricing snapshots, results and connection recovery now show 25 searchable
products per page. Confirmation/retry sits before the results table; the fresh
connection-review action precedes connection fields. Filtering never limits
the immutable job or discards off-page connection edits.

All 71 tests, typecheck, lint and app/worker builds passed locally, in CI and
on the deployment host. Both changed UI components passed Polaris App Home
v1 validation. The synthetic 300-product browser fixture verified off-page
search, pagination, attention filtering, preserved connection edits and complete
300-product fresh-review, import and retry scope while only one result was
visible. Desktop and 390-CSS-pixel mobile layouts had no horizontal overflow.
The fixture was stopped afterward; its jobs and mutations were not live.

HTTPS returned 200; app, worker and Nginx were active. Deployed source hashes
matched the committed files. No migrations were pending. SQLite integrity and
foreign keys passed, with exact preservation of all 33 jobs, 1,352 items,
207 creation claims and saved selection/pricing, plus stable inventory
identities, mappings, locations, enablement and revisions. No live imports were
queued by verification. Historical failures remain until an explicit retry or
fresh review; expired UPDATE snapshots require a fresh review.

The protected deployment backup is `20261011T235609205878Z.sqlite` (0600).
The preflight snapshot is `html-review-baseline-20261011T235523Z.sqlite` (0600).
The previous release and rollback symlink point to
`155cc24dc13ee4d5db6c0c501457ca5c61483d0c`. Production, Shopify app configuration
and scopes remain unchanged. The two pre-existing inventory-response failures
remain outside this release.

### Inventory missing-listing and stock recovery deployment, 2026-10-11

Release `6630e8981f93d6b932e397a8c66b305ab57d7e80` is committed, pushed
and deployed from its exact archive to the isolated integration lab. GitHub
App checks passed (run `38188259124`). It includes missing-listing handling
from `b9d95e5` and current-API stock input adaptation from `87d2517`.

Both original inventory failures (supplier IDs 71955 and 19969) were successful
Shopify lookups returning `product:null`, not malformed supplier-feed responses.
Their saved Shopify listings were no longer available. They now remain paused
in Needs review with explicit fresh-import-review guidance; mappings,
checkpoints and pending corrections are preserved. No replacement was created
or inventory re-enabled for either product.

Controlled live verification exposed two additional stock-path issues:
the pinned Admin API rejects the old `compareQuantity` wire field, and replay
of an already-applied uncertain correction returned a stale-comparison error.
Stock requests now send `changeFromQuantity`, leaving persisted corrections
unchanged. Recovery first verifies the approved pending quantities against
Shopify, skipping a confirmed write rather than relying only on replay.
Unconfirmed corrections still use their exact persisted input and retry key.

All 71 tests, typecheck, lint and app/worker builds passed locally, on the
deployment host and in CI. No migrations were pending. Offline tests cover
nonzero Shopify order reservations, uncertain sent/unsent corrections,
withdrawal, 250-quantity batching, missing listings and explicit recovery.

With the user's approval, supplier 17186 (SKU 1513) was temporarily enrolled
for live stock-only verification while the singleton worker was stopped and
its lock held. Its original on-hand stock was 327, with zero committed units.
Shopify rejected a stale comparison without changing stock. A one-unit drift
was corrected to 327; an acknowledged-response loss left a durable pending
record, and retry verified the stock without sending a duplicate correction.
Pause prevented updates, and explicit resume corrected a second one-unit drift.
Retailer content, prices, media, identity and product status were unchanged.
The original stock/reservations were restored and the temporary enrollment
removed. Live nonzero reservations were not manufactured; those remain covered
by isolated tests. No orders, publication or source-stock changes were made.

Both earlier failed verification attempts restored the sample before returning
their error. Protected recovery journals are retained under the lab backup
directory; temporary scripts and app-data journals were removed. The final
recovery journal is `inventory-verification-recovery-20261012.json` (0600).

Final comparison against `inventory-reconcile-baseline-20261012.sqlite`
confirmed exact preservation of all 35 jobs, 1,632 items, 227 claims, saved
selection/pricing and the two paused inventory rows. The earlier baseline
`inventory-missing-baseline-20261012T002154Z.sqlite` retains their original
enabled/failed state. The final protected deployment backup is
`20261012T003045467044Z.sqlite` (0600). SQLite integrity/foreign keys, services
and HTTPS passed; deployed source hashes match the commit.

The previous-release symlink points to intermediate release `87d2517`.
For a full rollback before these inventory changes, use `12162e9`; the
intermediate release still has the uncertain-replay issue described above.
Production, supplier/proxy code, scopes and app configuration were unchanged.

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

## Bulk inventory enrollment and cross-product batches

Release `b6a2af4` adds **Enable inventory sync for all** to Inventory. Its required
confirmation covers every currently imported eligible product, not just the
current search/filter. Already-enabled products retain their exact schedule and
revision; running or unverified listings and protected uncertain corrections are
not resumed or reset. The response reports enabled, already-enabled and skipped
counts with per-product reasons. An interrupted validation batch returns an
error and the exact partial result rather than claiming all products succeeded.
Future imports remain opt-in. Individual enable, pause and Sync now controls
remain available.

Normal worker cycles select up to five due products, retaining import priority.
They share one approved shop/location lookup, bounded Shopify `nodes` reads,
and a supplier SSH inventory operation. Shopify first pages contain up to 25
variants per product to bound requested query cost; larger products continue
through 100-variant pages, retaining the 2,048-variant per-product limit.
Supplier parent lookups and journal advancement are shared across products;
inventory source IDs are deduplicated into feed requests of at most 100 IDs.
Each product retains its own checkpoint, which advances only after stock
verification. Missing or invalid product records do not turn into invented
stock or prevent independently verifiable siblings from synchronizing.

Changed quantities from different products share Shopify corrections of at
most 250 quantities. Before dispatch, one SQLite transaction saves the same
complete request, participant list, idempotency key and timestamp on every
participating enrollment. Existing single-product pending corrections remain
compatible; no schema migration is required. Recovery reads the original
participants, including members outside the currently scheduled subset, and
never retries a shortened or changed mutation with the original key.
An acknowledged-but-lost write is confirmed from remote quantities without
resending. A paused or changed participant prevents an unconfirmed shared
correction from being replayed; already-confirmed quantities can be reconciled
without modifying paused stock. Confirmed Shopify rejection clears the shared
pending request so a later cycle can create a fresh compare-and-set correction.

An uncertain cross-product request older than Shopify's 24-hour retry window
pauses the participants for operator review and retains all correction records.
Unlike explicit single-product restart, individual enrollment cannot erase an
expired shared request. The operator must review every participating listing
and the full persisted operation together before clearing the group and
approving fresh inventory-only enrollment. Incomplete or inconsistent group
records also block replay. No automatic replacement or enrollment repair occurs.

Validation covers 300-product bulk scope, truthful partial enrollment,
five-product request-count reductions, 250/53 cross-product correction bounds,
2,048-variant pagination, reservations and retailer-field preservation,
pause-before-dispatch, missing/malformed siblings, uncertain responses,
restart/idempotent recovery and shared-key expiry/incomplete-ledger protection.

**Deployment order:** deploy the updated WordPress development feed client and
restricted catalog proxy **before** the app/worker release. The new proxy
operation is `inventory-sync-batch`; the existing `inventory-sync` operation
remains compatible. Do not enable production or bulk-enroll lab products as
part of deployment verification without explicit approval.

### Batch inventory deployment verification, 2026-10-12

App release `b6a2af4c413cbba73e3a166965593db6d657abf4` is committed, pushed
and deployed from its exact archive to the isolated lab. App checks passed
(run `38191931928`); all 73 tests, typecheck, lint and both builds also passed
on the deployment host. No migrations were pending. Generated inventory
queries passed Admin API 2026-10 schema validation; the inventory controls
passed Polaris App Home validation and offline browser checks.

The supplier batching dependency was deployed without drift as `4920e48`,
then merged through UltraLove PR #148 as `aa98f3f`. The merge CI and automatic
development deployment passed (runs `38192408281` and `38192408185`).
The restricted proxy was installed from the exact app release only after
its prior source hash matched git; credentials, forced-key restrictions,
firewalls and scopes were not changed.

A read-only live verification processed five imported single-variant
products through one supplier batch operation, one shop/location query
and one Shopify inventory batch query. Maximum requested GraphQL cost was
34, below Shopify's 1,000-point query limit. All five source stock plans
matched their existing Shopify quantities. No stock mutation or inventory
enrollment occurred. Cross-product corrections, uncertain responses,
pause/restart and expiry were verified in persistent isolated regressions,
not by modifying live stock. The 300-product browser fixture confirmed
that filtering to one row still targets all current imports, requires
confirmation, reports skipped listings and preserves individual pause.

Exact comparison with `inventory-batch-baseline-20261012T013058Z.sqlite`
preserved all 36 jobs, 1,758 import items, 227 claims, saved selection/pricing
and the two existing paused inventory rows. SQLite integrity/foreign keys,
HTTPS and all three services passed; implementation hashes match the archive.
The provisioner backup is `20261012T013058574820Z.sqlite` (0600).
The development WordPress backup is
`20261012T012858Z-7c6e42a910.tgz`; the protected proxy rollback copy is
`pre-inventory-batch-b6a2af4c413cbba73e3a166965593db6d657abf4.php`.
Temporary server verification code was removed.

The app's previous-release symlink is `6630e89`, the verified pre-batching
release. The new supplier/proxy retain the old single-product operation,
so this app rollback does not require reverting the supplier dependency.
Before rolling back after batch sync has been used, pause products with shared
pending corrections and retain their complete records: the old worker cannot
recover cross-product requests. Resolve them with the batch-capable release or
review the entire group before approving fresh enrollment; never erase one
participant's pending record to make an older worker proceed.
Missing listings 71955 and 19969 remain paused for reviewed recovery.
Bulk enrollment was not executed on the live store; production is unchanged.

## Current host and rollback

The deployed release is `b6a2af4` on the isolated integration-lab
droplet. Node 24.21.0 runs as `ultralove-shopify` on `127.0.0.1:3097`,
proxied by its separate HTTPS Nginx vhost. Source is under
`/srv/ultralove-shopify/releases`; `current` selects the release.
Sessions are in `/var/lib/ultralove-shopify/sessions.sqlite` (mode 0600).
The app environment is root-readable only at `/etc/ultralove-shopify/app.env`.
Request logging omits query parameters. The development supplier feed client
is deployed as `aa98f3f`; production WordPress is untouched.
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
