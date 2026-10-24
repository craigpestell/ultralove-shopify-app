#!/usr/bin/env bash
# Adds a custom-distribution copy of UltraLove Catalog for one retailer store, run once as root
# on the integration lab host. Shopify lets a custom-distribution app install on one store
# only, so each pilot retailer gets its own Shopify app record, and this host runs that app as a
# second instance of the current release: its own port, database, worker and HTTPS host name.
# provision-lab.sh migrates and restarts every instance on each deploy.
#
# Before running, save the app's Client ID and secret from the Shopify Dev Dashboard to
#   /root/.ultralove-integration-lab/<name>-client-id
#   /root/.ultralove-integration-lab/<name>-client-secret
# Usage: add-store-app.sh <name> <port> <store>.myshopify.com
#   e.g. add-store-app.sh source-adult 3101 source-adult.myshopify.com
set -euo pipefail
umask 077

[[ "$(hostname)" == "ultralove-integration-lab" ]] || { echo "Wrong host" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || { echo "Root required" >&2; exit 1; }
name="${1:?Provide a short name, such as source-adult}"
port="${2:?Provide an unused local port, such as 3101}"
shop="${3:?Provide the store domain, such as source-adult.myshopify.com}"
[[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || { echo "Invalid name" >&2; exit 1; }
[[ "$port" =~ ^3[1-9][0-9]{2}$ ]] || { echo "Use a port from 3100 to 3999" >&2; exit 1; }
[[ "$shop" =~ ^[a-z0-9][a-z0-9-]*\.myshopify\.com$ ]] || { echo "Invalid store domain" >&2; exit 1; }
[[ -L /srv/ultralove-shopify/current ]] || { echo "Deploy the lab app first" >&2; exit 1; }
if ss -ltn "( sport = :$port )" | grep -q LISTEN; then echo "Port $port is in use" >&2; exit 1; fi

host="shopify-$name.104-248-211-144.sslip.io"
environment="/etc/ultralove-shopify/stores/$name.env"
state="/var/lib/ultralove-shopify-stores/$name"
install -d -o root -g ultralove-shopify -m 750 /etc/ultralove-shopify/stores
install -d -o ultralove-shopify -g ultralove-shopify -m 700 /var/lib/ultralove-shopify-stores "$state"
if [[ ! -e "$environment" ]]; then
    NAME="$name" HOST_NAME="$host" PORT="$port" SHOP="$shop" STATE="$state" ENVIRONMENT="$environment" python3 - <<'PY'
import os, re
from pathlib import Path
base = Path("/root/.ultralove-integration-lab")
lab = Path("/etc/ultralove-shopify/app.env").read_text()
catalog = re.search(r"^CATALOG_SSH_HOST='([^'\n]*)'$", lab, re.M)
values = {
    "SHOPIFY_API_KEY": (base / f"{os.environ['NAME']}-client-id").read_text().strip(),
    "SHOPIFY_API_SECRET": (base / f"{os.environ['NAME']}-client-secret").read_text().strip(),
    "SHOPIFY_APP_URL": f"https://{os.environ['HOST_NAME']}",
    "SCOPES": "write_products,write_inventory,read_locations,read_publications,write_publications",
    "DATABASE_URL": f"file:{os.environ['STATE']}/sessions.sqlite",
    "HOST": "127.0.0.1",
    "PORT": os.environ["PORT"],
    # The store is approved here as well as in WordPress, so the pilot works before WordPress lists it.
    "APPROVED_SHOPS": os.environ["SHOP"],
    "CATALOG_SSH_HOST": catalog.group(1) if catalog else "",
}
if any(not value or "\n" in value or "\r" in value or "'" in value for value in values.values()):
    raise RuntimeError("Missing or unexpected app configuration; check the client ID, secret and lab CATALOG_SSH_HOST")
with Path(os.environ["ENVIRONMENT"]).open("x") as stream:
    for key, value in values.items():
        stream.write(f"{key}='{value}'\n")
PY
    chmod 600 "$environment"
fi

release="$(readlink /srv/ultralove-shopify/current)"
runuser -u ultralove-shopify -- env PATH="/opt/ultralove-node/bin:$PATH" DATABASE_URL="file:$state/sessions.sqlite" \
    bash -c 'cd "$1" && node_modules/.bin/prisma migrate deploy' bash "$release"
install -m 644 "$release/ops/ultralove-shopify-store@.service" /etc/systemd/system/ultralove-shopify-store@.service
install -m 644 "$release/ops/ultralove-shopify-store-imports@.service" /etc/systemd/system/ultralove-shopify-store-imports@.service
systemctl daemon-reload
systemctl enable --now "ultralove-shopify-store@$name" "ultralove-shopify-store-imports@$name"
for attempt in {1..30}; do
    curl --fail --silent "http://127.0.0.1:$port/" | grep 'UltraLove Catalog' >/dev/null && break
    [[ $attempt == 30 ]] && { echo "The $name app did not start; see journalctl -u ultralove-shopify-store@$name" >&2; exit 1; }
    sleep 1
done

if [[ ! -e "/etc/nginx/sites-available/shopify-$name" ]]; then
    sed -e "s/shopify-lab\.104-248-211-144\.sslip\.io/$host/" -e "s/127\.0\.0\.1:3097/127.0.0.1:$port/" \
        "$release/ops/shopify-lab.nginx.conf" >"/etc/nginx/sites-available/shopify-$name"
    chmod 644 "/etc/nginx/sites-available/shopify-$name"
    ln -s "/etc/nginx/sites-available/shopify-$name" "/etc/nginx/sites-enabled/shopify-$name"
    nginx -t
    systemctl reload nginx
    certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d "$host"
fi
curl --fail --silent --show-error "https://$host/" | grep 'UltraLove Catalog' >/dev/null
echo "The $name store app is serving at https://$host for $shop."
