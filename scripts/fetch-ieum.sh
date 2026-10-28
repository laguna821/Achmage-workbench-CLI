#!/usr/bin/env bash
# Fetch the IeumOffice source (https://github.com/pblsketch/openoffice, Apache-2.0) at the pinned
# commit into vendor/ieumoffice and install its dependencies without running install scripts.
# Workbench builds IeumOffice's editor screens from this checkout (apps/office) and never edits it.
# Usage: scripts/fetch-ieum.sh                         (the commit in vendor/ieumoffice.PINNED)
#        scripts/fetch-ieum.sh <sha|tag>               (another commit; update the PINNED file yourself)
#        scripts/fetch-ieum.sh <sha> --reinstall       (install the dependencies again)
# Does nothing when the checkout is already at the commit with its dependencies installed.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
pin_file="$repo/vendor/ieumoffice.PINNED"
want=${1:-$(sed -n 's/^commit: //p' "$pin_file")}
out="$repo/vendor/ieumoffice"

if [[ -d "$out/.git" ]] && [[ "$(git -C "$out" rev-parse HEAD)" == "$want"* ]]; then
  if [[ -f "$out/node_modules/.package-lock.json" && "${2:-}" != "--reinstall" ]]; then
    echo "vendor/ieumoffice is ready at ${want:0:12}"
    exit 0
  fi
  echo "vendor/ieumoffice is already at $want"
else
  rm -rf "$out"
  git init -q "$out"
  git -C "$out" remote add origin https://github.com/pblsketch/openoffice.git
  git -C "$out" fetch -q --depth 1 origin "$want"
  git -C "$out" -c advice.detachedHead=false checkout -q FETCH_HEAD
fi
echo "IeumOffice $(git -C "$out" rev-parse --short HEAD) ($(git -C "$out" log -1 --format=%cI))"
(cd "$out" && npm install --ignore-scripts --no-audit --no-fund --loglevel=error)
