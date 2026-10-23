---
name: app-ui-structure
description: Map of the UltraLove Catalog embedded admin UI (React Router + Polaris web components) and the lab theme sections. Use before changing or adding a page, view, form, button or link in app/, when tracing how Catalog, Selection & pricing, Review and Imports connect, when a loader/action or intent is involved, or when editing theme/ storefront sections.
---

# App UI structure

The admin UI is a React Router 7 app (`@shopify/shopify-app-react-router`) embedded in the Shopify admin of the lab store only. It renders Polaris **web components** (`<s-page>`, `<s-button>`, `<s-banner>`, `<s-spinner>`) mixed with plain HTML styled by `app/catalog.css`. There is no Polaris React. For infrastructure, CI and deploys, see the sibling skill [lab-infrastructure-deploy](../lab-infrastructure-deploy/SKILL.md).

Checked against `main` at `6bf59fc` (2026-10-22, after PR #26); the Settings row was added 2026-10-23.

## Route map

Routes are file based (`app/routes.ts` is `flatRoutes()`), so a file's name is its URL.

| File | URL | Purpose |
| --- | --- | --- |
| `routes/_index/route.tsx` | `/` | Public landing with a read-only login form for the lab shop. Redirects to `/app` when `?shop=` is present. |
| `routes/auth.login/route.tsx`, `routes/auth.$.tsx` | `/auth/*` | Shopify OAuth/login. `login()` in `shopify.server.ts` wraps it with `assertLabLogin`. |
| `routes/app.tsx` | `/app` layout | Authenticates, loads `savedConfiguration(shop)`, mounts `AppProvider`, `AdminLoadingBar` and `WorkspaceProvider` around `<Outlet />`. Exports Shopify's `boundary` ErrorBoundary and headers. |
| `routes/app._index.tsx` | `/app?view=…` | The **workspace**: Catalog, Selection & pricing, Review and Imports are one route switched by `?view=`. Default export is `CatalogWorkspace` from `app/catalog-workspace.tsx`. |
| `routes/app.settings.tsx` | `/app/settings` | Settings, top to bottom: **App version and updates** (running release, last update check, `check-updates` intent = Check now, which polls until the lab answers; `auto-updates` switch), **Inventory sync** (`inventory-sync` pause switch and health facts) and **Supplier feed** (version facts from `FeedVersionCheck`, `check-catalog` and `check-feed-version` intents). A paused feed version also shows a critical banner at the top of the page. |
| `routes/app.inventory.tsx` | `/app/inventory` | Inventory sync enrollment and deleted-listing recovery. Loader, action and component in one file. |
| `routes/app.imports.tsx` | `/app/imports` | Legacy: loader redirects to `/app?view=imports`; action delegates to `app._index`'s action so old forms and bookmarks still work. |
| `routes/app.selection-details.ts` | `/app/selection-details?ids=[…]` | Resource route (no component) used by a fetcher to load names/SKUs/prices for up to 50 selected IDs. `Cache-Control: no-store`. |
| `routes/webhooks.*.tsx` | `/webhooks/…` | `app/uninstalled`, `app/scopes_update` (declared in `shopify.app.toml`) and `products/delete` (registered per shop through the Admin API; marks the listing deleted). |

### Navigation

There is no `s-app-nav` / admin sidebar menu. Navigation is the in-page `WorkspaceNav` in `app/workspace.tsx`: **Catalog**, **Selection & pricing (n)**, **Imports**, **Inventory**, plus an "Integration lab · CAD" tag. Every tab is a `PendingLink` built by `workspaceHref(search, view, browse, job?)` from `app/workspace-policy.ts`, which:

- keeps the embedded context params (`shop`, `host`, `embedded`, `id_token`) from the current search,
- drops `index`, `view`, `job` and browse filters, then re-adds the last catalog filters (`draft.browse`) for `catalog` and `selection`,
- sends `inventory` to `/app/inventory` and everything else to `/app`.

Always build in-app links with `workspaceHref` (or the workspace's local `href()` for same-view filter changes) so the admin session params survive. `review` highlights the Selection tab.

## Pages: loader and action data

### Workspace (`app._index.tsx` + `catalog-workspace.tsx`)

**Loader** (`authenticateLabAdmin`): validates `job` (one 32-hex id) and browse filters (`browseFilters(url)`, 400 on bad input), then returns
`{ shop, ...importScreen(shop, job), filters, products, categories, error }`.

- `importScreen` (`imports.server.ts`) gives the saved configuration (`selected`, `markup`, `markups`, `fulfillmentModes`), `job` (the full snapshot with items, prices, listing review, warnings, `confirmation` token) and `history` (latest 10 jobs).
- For `view=review|imports` (or a `job` with no view) it skips the feed: `products`/`categories` are `null`.
- Otherwise it calls `productsPage(filters)` and `allCategories()` (`catalog.server.ts`, over the SSH catalog proxy). A `CatalogError` returns status 502 with `error` set instead of throwing.

**Action**: one form endpoint switched by the `intent` field. Every field is read with `field(name)` (exactly one string value).

| intent | Sent from | Does | Responds |
| --- | --- | --- | --- |
| `save-configuration` | Selection bar "Save changes" | Validates selection, markups, fulfillment modes; upserts `CatalogSelection` | `data({ error: null, saved: true })` |
| `save-selection` | Legacy | Same without pricing | same |
| `preview` | "Create pricing preview", `ListingRecovery`, `InventoryRecovery` | `createPreview(...)` builds a `PREVIEW` job snapshot (checks every variant through Admin GraphQL) | redirect to `view=review&job=<id>` |
| `queue` / `retry` | Review/Imports confirmation form | `queueJob(shop, id, retry, confirm)`; the `confirm` value must equal `job.confirmation` | redirect to `view=imports&job=<id>` |

Known domain errors (`ImportError`, `CatalogError`, `PricingError`, `ListingPolicyError`, `FulfillmentError`) become `data({ error, saved: false }, 400|502)`; anything else is rethrown to the boundary. Previews with recovery forms add a `recovery` field so their buttons can be matched as pending.

### Inventory (`app.inventory.tsx`)

- **Loader**: `{ products: inventoryScreen(shop) }` (imported products with sync status, fulfillment mode, errors, `deletedAt`, timestamps).
- **Action** intents: `enable` (needs `confirm=inventory-only`), `pause`, `sync-now` (per `supplierId`), and `enable-all` (needs `confirm=inventory-all-current`, no `supplierId`). Returns `{ error, supplierId, intent, bulk }`; `InventoryError` → 400.
- Revalidates every 10 s while products exist. Filters (all, sync on, needs review, deleted) and search are client state; `?filter=deleted` preselects the archive.
- Deleted rows render `InventoryRecovery`, whose forms post `intent=preview` to the workspace action (`workspaceHref(..., "review", ...)&index`), landing in Review.

## The Catalog → Selection → Review → Imports flow

1. **Catalog** (`view=catalog`): GET form for search/category (`Form method="get"`, keeps embedded params as hidden inputs), cursor pagination by `after_id` (50 per page). Checkboxes and "select all on page" (`pageSelection`) edit the **draft** only. The "All products / Selected only (n)" toggle pages through the selection client-side, with "Unselect all" and one-step Undo.
2. **Selection & pricing** (`view=selection`): the selected list (25 per page via `selectedPage`), per-product markup override and fulfillment mode (`CATALOG` or `DROPSHIPPING`), default markup, `ImportOptions` (active/publish for new products) and `ListingOptions` (keep or update existing listings). Missing product details load through the `selection-details` fetcher in batches of 50.
3. **Save** posts `save-configuration`; **Create pricing preview** posts the hidden `#configuration-form` (`intent=preview`, `ids`, `markups`, `markup`, `fulfillment-modes`, `listing-policy`, `active`, `publish`).
4. **Review** (`view=review&job=…`): `ImportResults` in review mode shows the immutable snapshot (exact CAD prices, proposed listing changes, warnings, replacements). It warns and disables confirmation when the preview is older than `MAX_PREVIEW_AGE` (10 minutes) or the draft no longer matches the snapshot (pricing, fulfillment, listing fields, visibility signatures). Confirm posts `queue` with the job's `confirmation` value.
5. **Imports** (`view=imports`): the same component plus "Recent activity". Running jobs revalidate every 3 s; `FAILED` jobs offer `retry`. `ListingRecovery` (connect existing Shopify products or accept replacements) posts a fresh `preview` from the job's own snapshot and replaces the working draft via `onRecoveryPreview`.
6. The **worker** (`import-worker.ts`, separate service) runs queued jobs, inventory batches and listing checks, and publishes the storefront status metafield.

### Draft state (`WorkspaceProvider`, `app/workspace.tsx`)

- The draft (`Draft` in `workspace-policy.ts`) holds `selected`, `markup`, `markups`, `fulfillmentModes`, `listingPolicy`, `active`, `publish`, known `products`, last catalog `browse` query and selection search/page.
- It lives in React context across views and is mirrored to `sessionStorage` under `ultralove-workspace-v1:<shop>`. It is restored after hydration only if its `baseline` signature still matches the server's saved configuration (`restoreDraft`).
- `dirty` = `signature(draft) !== signature(saved)`. The selection bar shows "Unsaved to store" / "Saved to store"; Reset restores the saved values. If storage is unavailable a warning banner shows and `beforeunload` guards unsaved work.
- Changing the selection must go through `select(nextIds)` in `catalog-workspace.tsx`, which also prunes overrides, fulfillment modes and listing links for removed IDs.

## Shared components and patterns

**Network state (`app/network-state.tsx`, PR #19; rules in `network-policy.ts`, documented in `AGENTS.md`).** Never read `useNavigation()` directly.

- `useNetworkState()` → `{ busy, pending }`. Use `busy` to disable inputs during any request and `pending(match)` for the `loading` prop of the control that started it. Match by `intent` (string or array), `method`, extra `fields` (e.g. `{ supplierId }` or `{ recovery }`), or a page load by `to`.
- `PendingLink` replaces `Link` for any link that loads data: spinner, `aria-busy`, repeat clicks ignored.
- `RequestFeedback` is the message component: shows one of a pending status line (`role="status"` + spinner), an error `s-banner tone="critical"` (`role="alert"`, optional children such as a retry link) or a success `s-banner tone="success"`. Pending wins over stale results; error wins over success.
- `AdminLoadingBar` (mounted once in `app.tsx`) drives `shopify.loading()` for navigations and fetchers.

**Other components**

- `ImportResults` (`import-results.tsx`): snapshot table, confirmation form, recent activity; used for both `review` and `imports`.
- `ImportOptions`, `ListingOptions`: fieldsets controlled by the draft via `onChange`.
- `ListingRecovery`, `InventoryRecovery`: recovery forms that create a fresh preview.
- `ProductImage`: catalog thumbnail with a hover/focus popover preview (`popover` API) and a placeholder on error.

**Conventions seen across pages**

- Wrap a page in `<s-page heading="UltraLove Catalog" inlineSize="large">` → `<div className="catalog-browser workspace">` → `<WorkspaceNav current=…/>` → `<header className="workspace-header">` with an `h1` and one sentence.
- Panels are `section.workspace-panel` with an `aria-label`/`aria-labelledby`; empty states are `div.workspace-empty` with an `h2`, a sentence and a next-step `PendingLink`.
- Wide tables sit in `div.catalog-table` with `tabIndex={0} role="region"` and a (visually hidden) `caption`.
- Destructive or store-changing actions need an explicit checkbox confirmation with a server-checked value; nothing imports, enrolls or publishes without it.
- Product names and SKUs from the feed pass through `supplierText()` (decodes entities, strips markup) before display.
- Admin product links go to `https://admin.shopify.com/store/ultralove-integration-lab/products/<id>` with `target="_blank"` and "(new tab)" in the text.
- Money is CAD; dates use `toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })`; status words come from `statusLabel()`.
- Pure logic lives in `*-policy.ts` / `*-engine.ts` (unit-testable); server-only data access in `*.server.ts`; components in `app/*.tsx`.

## Theme storefront sections (`theme/`)

Alternate templates for the lab store's Online Store theme; default templates are untouched. Push with `shopify theme push --store ultralove-integration-lab.myshopify.com --path theme --nodelete` (README "Lab storefront catalog and import status").

| Template | Section | Shows |
| --- | --- | --- |
| `collection.ultralove.json` (`/collections/all?view=ultralove`, or `/collections/all/ultralove-catalog-import?view=ultralove` for imports only) and `index.json` (home page) | `ultralove-catalog.liquid` | Paginated product grid (`per_page` 8–48, default 24). Outside a collection it uses the section's `collection` setting, default all products. Cards link with `?view=ultralove` and step through images with arrows. |
| `product.ultralove.json` (`/products/<handle>?view=ultralove`) | `ultralove-product.liquid` | Gallery (arrows, swipe, thumbnails, enlarge dialog), one select per option, selected variant price/compare-at/SKU/stock, add to cart, all-variants table. "Stock checked" reads `product.metafields.ultralove.inventory_checked_at` (written by the inventory sync). |
| `page.import-status.json` (assign to e.g. `/pages/import-status`) | `ultralove-import-status.liquid` | Latest import, recent imports and inventory sync summary from the shop metafield `ultralove.import_status` (JSON). |

Snippets: `ultralove-status-badge` (status pill) and `ultralove-stock` (variant stock wording). The status JSON is built by `importStatus()` in `app/storefront-status.ts` and written by `publishImportStatus()` in `storefront-status.server.ts`, which the worker calls at most once a minute after news and every 15 minutes otherwise. Changing that JSON shape means changing the Liquid section in the same PR. Only published products appear in the grid; imports create drafts unless the import publishes them.

## Adding a new page

1. **Route file**: `app/routes/app.<name>.tsx` gives `/app/<name>` inside the `app.tsx` layout (auth, `AppProvider`, workspace context). Use a `.ts` file with only a `loader` for data endpoints.
2. **Loader/action**: start each with `authenticateLabAdmin(request)` (never `authenticate.admin` alone; it also enforces the lab shop). Put data access in a `*.server.ts` module that calls `assertLabShop(shop)`. Read form values with an exact-one `field()` helper, switch on `intent`, throw a domain `Error` subclass for user errors and return `data({ error }, { status: 400 })`; rethrow anything else. Wrap Admin GraphQL as `admin.graphql(query, { variables, tries: 1 })`.
3. **Boundaries**: export `ErrorBoundary` (`boundary.error(useRouteError())`) and `headers` (`boundary.headers`) from every route, as the existing ones do.
4. **Navigation**: add `[view, label]` to `WorkspaceNav` and teach `workspaceHref` the new path (today only `inventory` maps to its own route). A view of the workspace instead goes in the `view` list and `names` map in `catalog-workspace.tsx` and the loader's skip-feed check.
5. **UI**: follow the page skeleton above, `import "../catalog.css"`, use `PendingLink`, `useNetworkState` and `RequestFeedback` for every request, and add empty and error states. Use Polaris web components (see the `shopify-polaris` skill if available) for buttons, banners and spinners.
6. **Tests**: put pure rules in a `*-policy.ts` with a `tests/*.test.mjs` (node:test). Components are rendered in tests with Vite `ssrLoadModule` plus `createStaticHandler`/`StaticRouterProvider` and `renderToStaticMarkup` (see `tests/listing-ui.test.mjs`, `tests/network-state.test.mjs`).
7. **Check**: `npm run check` (tests, typecheck, lint, app and worker build; Node ≥ 24). UI changes still need a look in the lab store admin; deploys follow [lab-infrastructure-deploy](../lab-infrastructure-deploy/SKILL.md).
8. Update this skill's route map when a page is added, renamed or removed.
