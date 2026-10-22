#!/usr/bin/env bash
# Forced command for the lab's GitHub Actions deploy key, installed by provisioning as
# /usr/local/sbin/ultralove-shopify-deploy. The key can only name a commit SHA; the
# commit is fetched from GitHub and deployed only while it is the tip of main and its
# App checks run passed.
# Usage (over SSH): <full commit SHA>
{
set -euo pipefail
umask 022
repository=craigpestell/ultralove-shopify-app
root=/srv/ultralove-shopify
source="$root/source.git"
release="${SSH_ORIGINAL_COMMAND:-${1:-}}"
[[ "$release" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected a full commit SHA" >&2; exit 2; }

exec 9>/run/ultralove-shopify-deploy.lock
flock 9

[[ -d "$source" ]] || git init --quiet --bare "$source"
git -C "$source" fetch --quiet "https://github.com/$repository.git" +refs/heads/main:refs/heads/main
tip="$(git -C "$source" rev-parse refs/heads/main)"
if [[ "$tip" != "$release" ]]; then
    echo "main is now at $tip; skipping $release."
    exit 0
fi

curl --fail --silent --show-error \
    "https://api.github.com/repos/$repository/actions/runs?head_sha=$release&event=push" |
    python3 -c 'import json, sys
runs = json.load(sys.stdin)["workflow_runs"]
sys.exit(0 if any(r["name"] == "App checks" and r["conclusion"] == "success" for r in runs) else 1)' ||
    { echo "App checks have not passed for $release" >&2; exit 1; }

directory="$root/releases/$release"
if [[ ! -e "$directory" ]]; then
    rm -rf "$directory.tmp"
    install -d -m 755 "$directory.tmp"
    git -C "$source" archive --format=tar "$release" | tar -x -C "$directory.tmp"
    mv "$directory.tmp" "$directory"
fi
bash "$directory/ops/provision-lab.sh" "$release"
exit
}
