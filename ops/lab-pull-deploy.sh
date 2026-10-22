#!/usr/bin/env bash
# Pull deploy for the integration lab, installed by provisioning as
# /usr/local/sbin/ultralove-shopify-deploy and run every 24 hours by
# ultralove-shopify-deploy.timer, and by ultralove-shopify-deploy.path when the app's
# Settings page asks for a check now. Fetches main from GitHub and deploys its tip once
# its App checks run has passed. A release that fails to provision is recorded and
# not retried until main moves on. Timer runs do nothing while automatic updates are
# off in Settings; a check requested from Settings or an explicit SHA still runs. Each
# run writes its outcome to status.json, with the request ID it answers, for Settings.
# Usage: ultralove-shopify-deploy [full commit SHA]   (default: tip of main)
{
set -euo pipefail
umask 022
repository=craigpestell/ultralove-shopify-app
root=/srv/ultralove-shopify
source="$root/source.git"
failed=/var/lib/ultralove-shopify-deploy/failed
status=/var/lib/ultralove-shopify-deploy/status.json
request_file=/var/lib/ultralove-shopify/update-check-request
handled=/var/lib/ultralove-shopify-deploy/handled-request
request=""
recorded=false

exec 9>/run/ultralove-shopify-deploy.lock
flock 9

install -d -m 755 "${status%/*}"
record() {
    printf '{"checkedAt":"%s","result":"%s","release":"%s","checks":"%s","request":"%s"}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:-}" "${3:-}" "$request" >"$status.tmp"
    mv "$status.tmp" "$status"
    recorded=true
}
trap 'code=$?; [[ $code == 0 || $recorded == true ]] || record error' EXIT

# A request ID that has not been answered yet means Settings asked for a check now.
if [[ $# == 0 && -f "$request_file" ]]; then
    candidate="$(head -c 100 "$request_file" | tr -d '\n')"
    if [[ "$candidate" =~ ^[a-f0-9-]{36}$ && "$candidate" != "$(cat "$handled" 2>/dev/null)" ]]; then
        request="$candidate"
        echo "$request" >"$handled"
        echo "Checking now, as requested from Settings."
    fi
fi

# A missing database, table or row means automatic updates are on.
if [[ $# == 0 && -z "$request" ]] && ! python3 - <<'PY'
import sqlite3, sys
try:
    with sqlite3.connect("file:/var/lib/ultralove-shopify/sessions.sqlite?mode=ro", uri=True) as db:
        row = db.execute("SELECT autoUpdates FROM AppSettings WHERE id = 'lab'").fetchone()
except sqlite3.Error:
    row = None
sys.exit(1 if row and not row[0] else 0)
PY
then
    echo "Automatic updates are off in the app's Settings; not checking main."
    record off
    exit 0
fi

[[ -d "$source" ]] || git init --quiet --bare "$source"
git -C "$source" fetch --quiet "https://github.com/$repository.git" +refs/heads/main:refs/heads/main
release="${1:-$(git -C "$source" rev-parse refs/heads/main)}"
[[ "$release" =~ ^[a-f0-9]{40}$ ]] || { echo "Expected a full commit SHA" >&2; exit 2; }
git -C "$source" merge-base --is-ancestor "$release" refs/heads/main ||
    { echo "$release is not on main" >&2; exit 2; }

if [[ $# == 0 ]]; then
    [[ "$(readlink "$root/current")" == "$root/releases/$release" ]] && { record current "$release"; exit 0; }
    [[ "$(cat "$failed" 2>/dev/null)" == "$release" ]] && { record failed "$release"; exit 0; }
fi

checks="$(curl --fail --silent --show-error \
    "https://api.github.com/repos/$repository/actions/runs?head_sha=$release&event=push" |
    python3 -c 'import json, sys
runs = [r for r in json.load(sys.stdin)["workflow_runs"] if r["name"] == "App checks"]
print(runs[0]["conclusion"] or runs[0]["status"] if runs else "missing")')"
if [[ "$checks" != success ]]; then
    echo "App checks for $release: $checks; not deploying."
    record waiting "$release" "$checks"
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
# Provisioning restarts the app, so Settings learns the outcome before it goes away.
record deploying "$release"
if ! bash "$directory/ops/provision-lab.sh" "$release"; then
    echo "$release" >"$failed"
    record failed "$release"
    echo "Provisioning $release failed; it will not be retried until main changes." >&2
    exit 1
fi
rm -f "$failed"
record deployed "$release"
exit
}
