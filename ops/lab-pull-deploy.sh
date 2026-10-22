#!/usr/bin/env bash
# Pull deploy for the integration lab, installed by provisioning as
# /usr/local/sbin/ultralove-shopify-deploy and run every few minutes by
# ultralove-shopify-deploy.timer. Fetches main from GitHub and deploys its tip once
# its App checks run has passed. A release that fails to provision is recorded and
# not retried until main moves on.
# Usage: ultralove-shopify-deploy [full commit SHA]   (default: tip of main)
{
set -euo pipefail
umask 022
repository=craigpestell/ultralove-shopify-app
root=/srv/ultralove-shopify
source="$root/source.git"
failed=/var/lib/ultralove-shopify-deploy/failed

exec 9>/run/ultralove-shopify-deploy.lock
flock 9

[[ -d "$source" ]] || git init --quiet --bare "$source"
git -C "$source" fetch --quiet "https://github.com/$repository.git" +refs/heads/main:refs/heads/main
release="${1:-$(git -C "$source" rev-parse refs/heads/main)}"
[[ "$release" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected a full commit SHA" >&2; exit 2; }
git -C "$source" merge-base --is-ancestor "$release" refs/heads/main ||
    { echo "$release is not on main" >&2; exit 2; }

if [[ $# == 0 ]]; then
    [[ "$(readlink "$root/current")" == "$root/releases/$release" ]] && exit 0
    [[ "$(cat "$failed" 2>/dev/null)" == "$release" ]] && exit 0
fi

checks="$(curl --fail --silent --show-error \
    "https://api.github.com/repos/$repository/actions/runs?head_sha=$release&event=push" |
    python3 -c 'import json, sys
runs = [r for r in json.load(sys.stdin)["workflow_runs"] if r["name"] == "App checks"]
print(runs[0]["conclusion"] or runs[0]["status"] if runs else "missing")')"
if [[ "$checks" != success ]]; then
    echo "App checks for $release: $checks; not deploying."
    exit 0
fi

echo "Deploying $release"
directory="$root/releases/$release"
if [[ ! -e "$directory" ]]; then
    rm -rf "$directory.tmp"
    install -d -m 755 "$directory.tmp"
    git -C "$source" archive --format=tar "$release" | tar -x -C "$directory.tmp"
    mv "$directory.tmp" "$directory"
fi
install -d -m 755 "${failed%/*}"
if ! bash "$directory/ops/provision-lab.sh" "$release"; then
    echo "$release" >"$failed"
    echo "Provisioning $release failed; it will not be retried until main changes." >&2
    exit 1
fi
rm -f "$failed"
exit
}
