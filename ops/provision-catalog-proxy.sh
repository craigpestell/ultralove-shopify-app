#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(hostname)" == ultralove-dev-managed && "$(id -u)" == 0 ]] || { echo "Wrong proxy host" >&2; exit 1; }
key="$(cat)"
[[ "$key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+\ [A-Za-z0-9@._-]+$ ]] || { echo "Invalid public key" >&2; exit 1; }
source_dir="$(cd "$(dirname "$0")" && pwd)"
if ! id ultralove-catalog-proxy >/dev/null 2>&1; then
    useradd --system --home /var/lib/ultralove-catalog-proxy --shell /bin/sh ultralove-catalog-proxy
fi
install -d -o root -g root -m 755 /var/lib/ultralove-catalog-proxy
install -d -o root -g root -m 755 /var/lib/ultralove-catalog-proxy/.ssh
printf 'from="104.248.211.144",restrict,command="/usr/bin/php8.5 /usr/local/libexec/ultralove-catalog-proxy.php" %s\n' "$key" \
    > /var/lib/ultralove-catalog-proxy/.ssh/authorized_keys
chmod 644 /var/lib/ultralove-catalog-proxy/.ssh/authorized_keys
install -d -m 755 /usr/local/libexec
install -m 644 "$source_dir/catalog-proxy.php" /usr/local/libexec/ultralove-catalog-proxy.php
php8.5 -l /usr/local/libexec/ultralove-catalog-proxy.php
cd /var/www/html
wp --allow-root eval-file "$source_dir/setup-catalog-proxy.php"
/usr/sbin/sshd -t
echo "Restricted dev catalog proxy installed; no firewall or Cloudflare policy changed."
