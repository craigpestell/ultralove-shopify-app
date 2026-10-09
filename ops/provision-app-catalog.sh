#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(hostname)" == ultralove-integration-lab && "$(id -u)" == 0 ]] || { echo "Wrong app host" >&2; exit 1; }
host="${1:?Provide the verified dev IPv4 address}"
[[ "$host" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "Invalid dev address" >&2; exit 1; }
python3 -c 'import ipaddress,sys; ipaddress.IPv4Address(sys.argv[1])' "$host"
if grep -q '^CATALOG_SSH_HOST=' /etc/ultralove-shopify/app.env &&
    ! grep -Fxq "CATALOG_SSH_HOST='$host'" /etc/ultralove-shopify/app.env; then
    echo "Configured supplier differs from the verified target; review before changing it." >&2
    exit 1
fi
host_key="$(cat)"
[[ "$host_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+\ [A-Za-z0-9@._-]+$ ]] || { echo "Invalid verified host key" >&2; exit 1; }
install -d -o root -g ultralove-shopify -m 750 /etc/ultralove-shopify
install -d -o root -g ultralove-shopify -m 750 /etc/ultralove-shopify/catalog
key=/etc/ultralove-shopify/catalog/catalog_ed25519
[[ ! -L "$key" ]] || { echo "Unsafe key path" >&2; exit 1; }
if [[ ! -e "$key" ]]; then
    ssh-keygen -q -t ed25519 -N '' -C ultralove-shopify-catalog -f "$key"
fi
chown root:ultralove-shopify "$key"
chmod 640 "$key"
printf '%s %s\n' "$host" "$host_key" > /etc/ultralove-shopify/catalog/known_hosts
chown root:ultralove-shopify /etc/ultralove-shopify/catalog/known_hosts
chmod 640 /etc/ultralove-shopify/catalog/known_hosts
if ! grep -q '^CATALOG_SSH_HOST=' /etc/ultralove-shopify/app.env; then
    printf "CATALOG_SSH_HOST='%s'\n" "$host" >> /etc/ultralove-shopify/app.env
fi
echo "App catalog key provisioned; private material was not displayed."
