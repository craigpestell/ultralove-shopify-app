#!/usr/bin/env bash
# Deploys a commit of this repository to the integration-lab droplet from a workstation.
# Usage: ops/deploy-lab.sh [git ref]   (default: origin/main)
#        ops/deploy-lab.sh --rollback  (reprovisions the release that "previous" points to)
# LAB_SSH overrides the SSH target (default root@104.248.211.144).
set -euo pipefail

lab="${LAB_SSH:-root@104.248.211.144}"
root=/srv/ultralove-shopify
url=https://shopify-lab.104-248-211-144.sslip.io/
cd "$(git rev-parse --show-toplevel)"

ssh -o BatchMode=yes "$lab" true || { echo "Cannot reach $lab over SSH" >&2; exit 1; }

if [[ "${1:-}" == --rollback ]]; then
    release="$(ssh "$lab" "basename \"\$(readlink $root/previous)\"")"
    [[ "$release" =~ ^[a-f0-9]{40}$ ]] || { echo "No previous release recorded" >&2; exit 1; }
    echo "Rolling back to $release"
else
    ref="${1:-origin/main}"
    git fetch --quiet origin
    release="$(git rev-parse --verify "$ref^{commit}")"
    echo "Deploying $ref ($release)"

    if command -v gh >/dev/null; then
        repository="$(git remote get-url origin | sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##')"
        checks="$(gh run list --repo "$repository" --commit "$release" --workflow "App checks" --json conclusion --jq '.[0].conclusion' 2>/dev/null || true)"
        if [[ "$checks" != success ]]; then
            echo "App checks for $release: ${checks:-not found}." >&2
            [[ "${FORCE:-}" == 1 ]] || { echo "Set FORCE=1 to deploy anyway." >&2; exit 1; }
        fi
    fi

    if ssh "$lab" "test -e $root/releases/$release"; then
        echo "Release directory already exists on the lab; reprovisioning it."
    else
        git archive --format=tar "$release" |
            ssh "$lab" "set -e; install -d -m 755 $root/releases/$release.tmp &&
                tar -x -C $root/releases/$release.tmp &&
                mv $root/releases/$release.tmp $root/releases/$release"
    fi
fi

before="$(ssh "$lab" "readlink $root/current")"
ssh "$lab" "flock /run/ultralove-shopify-deploy.lock bash $root/releases/$release/ops/provision-lab.sh $release"

current="$(ssh "$lab" "readlink $root/current")"
[[ "$current" == "$root/releases/$release" ]] || { echo "current points to $current, expected $release" >&2; exit 1; }
ssh "$lab" "systemctl is-active ultralove-shopify ultralove-shopify-imports nginx"
curl --fail --silent --show-error "$url" | grep 'UltraLove Catalog' >/dev/null
echo "Lab now serves $release over HTTPS (was ${before##*/})."
echo "Recent app log:"
ssh "$lab" "journalctl -u ultralove-shopify -u ultralove-shopify-imports --since '-2 min' --no-pager -n 20"
