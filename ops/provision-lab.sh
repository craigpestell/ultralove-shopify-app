#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$(hostname)" == "ultralove-integration-lab" ]] || { echo "Wrong host" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || { echo "Root provisioning required" >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { echo "Unsupported architecture" >&2; exit 1; }
release="${1:?Provide the full release SHA}"
[[ "$release" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid release SHA" >&2; exit 1; }
directory="/srv/ultralove-shopify/releases/$release"
[[ -f "$directory/package-lock.json" ]] || { echo "Missing release" >&2; exit 1; }

if [[ ! -x /opt/ultralove-node/bin/node ]]; then
    install -d -m 755 /opt/ultralove-node
    archive="$(mktemp /tmp/ultralove-node.XXXXXX.tar.xz)"
    trap 'rm -f "$archive"' EXIT
    curl --fail --silent --show-error \
        https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz -o "$archive"
    printf 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6  %s\n' "$archive" | sha256sum -c -
    tar -xJf "$archive" --strip-components=1 -C /opt/ultralove-node
    chown -R root:root /opt/ultralove-node
fi
export PATH="/opt/ultralove-node/bin:$PATH"
[[ "$(node --version)" == v24.* ]] || { echo "Node 24 required" >&2; exit 1; }

if ! id ultralove-shopify >/dev/null 2>&1; then
    useradd --system --home /var/lib/ultralove-shopify --shell /usr/sbin/nologin ultralove-shopify
fi
install -d -o ultralove-shopify -g ultralove-shopify -m 700 /var/lib/ultralove-shopify
install -d -o root -g ultralove-shopify -m 750 /etc/ultralove-shopify
if [[ ! -e /etc/ultralove-shopify/app.env ]]; then
    python3 - <<'PY'
from pathlib import Path
base = Path("/root/.ultralove-integration-lab")
values = {
    "SHOPIFY_API_KEY": (base / "shopify-client-id").read_text().strip(),
    "SHOPIFY_API_SECRET": (base / "shopify-client-secret").read_text().strip(),
    "SHOPIFY_APP_URL": "https://shopify-lab.104-248-211-144.sslip.io",
    "SCOPES": "write_products,write_inventory,read_locations,read_publications,write_publications,write_orders,write_merchant_managed_fulfillment_orders,write_fulfillments",
    "DATABASE_URL": "file:/var/lib/ultralove-shopify/sessions.sqlite",
    "HOST": "127.0.0.1",
    "PORT": "3097",
}
if any(not value or "\n" in value or "\r" in value or "'" in value for value in values.values()):
    raise RuntimeError("Unexpected app configuration format")
with Path("/etc/ultralove-shopify/app.env").open("x") as stream:
    for key, value in values.items():
        stream.write(f"{key}='{value}'\n")
PY
    chmod 600 /etc/ultralove-shopify/app.env
fi

chown -R ultralove-shopify:ultralove-shopify "$directory"
if [[ -f /var/lib/ultralove-shopify/sessions.sqlite ]]; then
    install -d -o root -g root -m 700 /srv/ultralove-shopify/backups
    python3 - <<'PY'
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
destination = Path("/srv/ultralove-shopify/backups") / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".sqlite")
with sqlite3.connect("file:/var/lib/ultralove-shopify/sessions.sqlite?mode=ro", uri=True) as source:
    with sqlite3.connect(destination) as backup:
        source.backup(backup)
destination.chmod(0o600)
print("Protected persistent session/job database backup created.")
PY
fi
runuser -u ultralove-shopify -- env PATH="$PATH" DATABASE_URL=file:/var/lib/ultralove-shopify/sessions.sqlite \
    bash -c 'cd "$1" && npm ci && npm run setup && npm run check' bash "$directory"
chown -R root:root "$directory"
chmod -R a+rX "$directory"
chmod -R go-w "$directory"
if systemctl is-active --quiet ultralove-shopify-imports; then
    systemctl stop ultralove-shopify-imports
fi

if [[ -L /srv/ultralove-shopify/current ]]; then
    ln -sfn "$(readlink /srv/ultralove-shopify/current)" /srv/ultralove-shopify/previous
fi
ln -sfn "$directory" /srv/ultralove-shopify/current
install -m 644 "$directory/ops/ultralove-shopify.service" /etc/systemd/system/ultralove-shopify.service
install -m 644 "$directory/ops/ultralove-shopify-imports.service" /etc/systemd/system/ultralove-shopify-imports.service
systemd-analyze verify /etc/systemd/system/ultralove-shopify.service /etc/systemd/system/ultralove-shopify-imports.service
systemctl daemon-reload
systemctl enable ultralove-shopify
systemctl restart ultralove-shopify
systemctl enable ultralove-shopify-imports
systemctl restart ultralove-shopify-imports
systemctl is-active ultralove-shopify
ready=false
for attempt in {1..30}; do
    if curl --fail --silent http://127.0.0.1:3097/ | grep 'UltraLove Dropshipping Lab' >/dev/null; then
        ready=true
        break
    fi
    sleep 1
done
[[ "$ready" == true ]] || { echo "App readiness check failed" >&2; exit 1; }

if [[ ! -e /etc/nginx/sites-available/shopify-lab ]]; then
    install -m 644 "$directory/ops/shopify-lab.nginx.conf" /etc/nginx/sites-available/shopify-lab
    ln -s /etc/nginx/sites-available/shopify-lab /etc/nginx/sites-enabled/shopify-lab
    nginx -t
    systemctl reload nginx
    certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email \
        --redirect -d shopify-lab.104-248-211-144.sslip.io
fi
nginx -t
systemctl is-active nginx ultralove-shopify ultralove-shopify-imports
curl --fail --silent --show-error https://shopify-lab.104-248-211-144.sslip.io/ |
    grep 'UltraLove Dropshipping Lab' >/dev/null
echo "Lab app release $release is serving over HTTPS."
