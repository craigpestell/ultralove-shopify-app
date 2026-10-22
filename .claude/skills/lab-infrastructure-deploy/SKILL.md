---
name: lab-infrastructure-deploy
description: Infrastructure, CI and deployment of the UltraLove Catalog Shopify app on the integration-lab droplet. Use when asked to deploy, ship, roll back or check the app ("deploy to shopify", "deploy to the lab"), when a deploy or the lab app fails, when touching ops/, server.mjs, systemd units, nginx or shopify.app.toml, or when reviewing dependency bumps that could stop the server starting.
---

# Lab infrastructure and deployment

For the admin UI (routes, loaders/actions, workspace flow, shared components) and the theme/ storefront sections, see [app-ui-structure](../app-ui-structure/SKILL.md).

## Where it runs

- Host: DigitalOcean droplet `ultralove-integration-lab`, `root@104.248.211.144` (no `~/.ssh/config` alias). Not WordPress dev/prod.
- Public URL: `https://shopify-lab.104-248-211-144.sslip.io` (Nginx vhost `shopify-lab`, certbot TLS) proxies to `127.0.0.1:3097`.
- Releases: `/srv/ultralove-shopify/releases/<full SHA>`; symlinks `current` and `previous` select the live and rollback release. Old releases are never pruned automatically.
- Services (units in `ops/`, installed by provisioning):
  - `ultralove-shopify`: `node server.mjs` (Express + React Router), user `ultralove-shopify`, env from `/etc/ultralove-shopify/app.env` (root-only, generated once from `/root/.ultralove-integration-lab/`).
  - `ultralove-shopify-imports`: `build/worker/worker.mjs` under `flock`, imports and inventory sync.
- Data: SQLite at `/var/lib/ultralove-shopify/sessions.sqlite` (sessions, jobs, claims, inventory). Backups before each provision in `/srv/ultralove-shopify/backups` (root, 0600).
- Node 24 at `/opt/ultralove-node`, pinned and checksum-verified by `ops/provision-lab.sh`.
- Catalog feed: restricted SSH forced-command proxy to dev WordPress (`ultralove-catalog-proxy@138.68.43.251`); see README "Live catalog connection" and `ops/provision-*catalog*`.

## CI

`.github/workflows/ci.yml` ("App checks") runs `npm ci`, `prisma generate`, `npm run check` (node tests, typecheck, lint, app and worker build) on every push and PR. It never starts `server.mjs`, so a dependency bump can pass CI and still crash at startup (Express 5 rejected `app.all("*")`). Dependabot opens weekly npm and Actions PRs; treat major bumps of express, react-router, prisma or @shopify/* as needing a boot check.

## Deploying app code

From a workstation with root SSH to the lab, in the repo:

```bash
ops/deploy-lab.sh [git ref]   # default origin/main
```

It refuses a commit without a passing App checks run (`FORCE=1` overrides), copies the exact `git archive` to `releases/<sha>`, and runs `ops/provision-lab.sh <sha>` as root. Provisioning: SQLite backup, `npm ci`, `npm run setup` (prisma generate + `migrate deploy` against the live DB), `npm run check`, boot test on port 3098, then switches `current`/`previous`, restarts both services, checks local readiness, Nginx and HTTPS for "UltraLove Catalog". The script then confirms the symlink, services and HTTPS and shows recent journal lines.

- Merges to `main` deploy automatically by pull: `ultralove-shopify-deploy.timer` (every 5 min) runs `/usr/local/sbin/ultralove-shopify-deploy` (`ops/lab-pull-deploy.sh`, installed by provisioning), which fetches `main` into `/srv/ultralove-shopify/source.git` and provisions its tip once that commit's App checks push run passed and it differs from `current`. GitHub cannot SSH in: ufw allows port 22 only from the maintainer's IP, so do not reintroduce a push-based Actions deploy. A failed release is recorded in `/var/lib/ultralove-shopify-deploy/failed` and skipped until `main` changes; check `journalctl -u ultralove-shopify-deploy`, then fix forward or roll back manually. Manual and automatic deploys share `/run/ultralove-shopify-deploy.lock`.
- The app's Settings page has an "Automatic app updates" switch (`AppSettings.autoUpdates` in the SQLite DB). When it is off, timer runs exit without fetching; `ultralove-shopify-deploy <sha>` and `ops/deploy-lab.sh` still deploy. Every run writes its outcome (`off`, `current`, `waiting`, `deployed`, `failed`, `error`) to `/var/lib/ultralove-shopify-deploy/status.json`, which Settings shows with the running release from the `current` symlink. Settings can also pause inventory sync for every product (`AppSettings.inventoryPaused`); the imports worker then starts no inventory cycles until it is resumed.
- Manual deploys change a live server: tell the user the ref and SHA and get a go-ahead first.
- Never push to `main`; deploy from a reviewed PR commit or merged main.
- Rollback: `ops/deploy-lab.sh --rollback` reprovisions the `previous` release. Migrations are additive and are not reversed; stop `ultralove-shopify-imports` before returning to a pre-jobs release (README "Current host and rollback").

## Shopify app configuration (separate)

`shopify.app.toml` (scopes, webhooks, URLs) reaches Shopify only via `npm run deploy` / `shopify app deploy`. `client_id` is intentionally blank, it has never been deployed from this repo, and it must be linked to the existing app (org `239653376`, app `433204330497`), never a new one. Always confirm with the user before linking or deploying config; preserve existing scopes and the worker's client-credentials access. Webhook subscriptions can instead be registered per shop through the Admin API (as done for `PRODUCTS_DELETE`).

## Checks after a deploy

```bash
ssh root@104.248.211.144 'readlink /srv/ultralove-shopify/current; systemctl is-active ultralove-shopify ultralove-shopify-imports nginx; journalctl -u ultralove-shopify-imports -n 30 --no-pager'
```

Authenticated UI checks need the Shopify admin of `ultralove-integration-lab.myshopify.com`; only that shop is accepted.
