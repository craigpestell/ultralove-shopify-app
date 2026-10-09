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

Pricing, draft-import jobs and ongoing inventory synchronization are subsequent
steps. The existing
feed and root-only PHP workers remain in `craigpestell/ultralove`; this web
process must never run those workers as root or read their credential files.
No orders, payments, emails, shipments or storefront publication are enabled.

## Local validation

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

Unused GraphQL demo/code-generation dependencies are omitted. Prisma's config
dependency uses a scoped `deepmerge-ts` 8 override for its recursion advisory;
Prisma generation, schema validation and migrations must pass with that override.

### Verification recorded, 2026-10-09

- Eleven offline authentication/catalog policy tests passed; type-check, lint and
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
- Clear selection reset the unsaved selection to `[]`. Existing saved selections
  were preserved during final checks. No import was invoked by this interface.
- Deployed foreign-shop requests returned 403, invalid-signature webhooks returned
  401, and responses carried `Cache-Control: no-store`. App, Nginx and lab PHP-FPM
  were active; the app listener remained loopback-only.
- The original dev worker still synced SKUs `1513`, `2455` and `70072`, preserving
  retailer prices. These checks do not establish independent-store onboarding or
  real-order fulfilment.

## Existing Shopify app

Verified in the Dev Dashboard on 2026-10-09:

- Organization: `239653376`; app: `433204330497`.
- Active version: `ultralove-lab-embedded-foundation`.
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
selection and preserved retailer prices. The installed version and scopes above
are the reviewed foundation configuration.

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
is unchanged. No WordPress runtime code deployment is needed for this adapter.

The app source is published in the private GitHub repository. Its `main` branch
contains the previously deployed foundation; `feat/embedded-catalog` contains
the catalog and hosting increment for review. The running release was deployed
from a git archive, independently of merging that branch. Production rollout
and independent retailer onboarding require separate work and approval.

## Current host and rollback

The deployed catalog release is `05f1160` on the isolated integration-lab
droplet. Node 24.21.0 runs as `ultralove-shopify` on `127.0.0.1:3097`,
proxied by its separate HTTPS Nginx vhost. Source is under
`/srv/ultralove-shopify/releases`; `current` selects the release.
Sessions are in `/var/lib/ultralove-shopify/sessions.sqlite` (mode 0600).
The app environment is root-readable only at `/etc/ultralove-shopify/app.env`.
Request logging omits query parameters. Existing supplier WordPress is untouched.

The pre-update Shopify version `ultralove-dropshipping-lab-2` remains available
for rollback: restore it in the Dev Dashboard to return to the old supplier-lab
URL and non-embedded mode. Do not uninstall/recreate the app or rotate its secret.
The preceding local hosting release `a419640` failed due to file read permissions
and is **not** a usable code rollback. The verified foundation `a271a77` remains
an earlier code rollback, but does not provide catalog browsing. Code rollback
does not undo persistent session or selection migrations.
