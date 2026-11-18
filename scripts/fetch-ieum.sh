#!/usr/bin/env bash
# Fetch the IeumOffice source (https://github.com/pblsketch/ieumoffice, Apache-2.0; formerly
# pblsketch/openoffice) at the pinned commit into vendor/ieumoffice and install its dependencies without
# running install scripts. Workbench builds IeumOffice's editor screens from this checkout (apps/office)
# and never edits it. While a part (the Hangul page, Google Drive) still builds from an earlier pin
# (scripts/ieum-earlier-source.mjs), that checkout is fetched the same way into its own folder.
# Usage: scripts/fetch-ieum.sh                         (the commits in the PINNED files)
#        scripts/fetch-ieum.sh <sha|tag>               (another commit for vendor/ieumoffice; update the PINNED file yourself)
#        scripts/fetch-ieum.sh <sha> --reinstall       (install the dependencies again)
# Does nothing when a checkout is already at its commit with its dependencies installed.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)

fetch() { # <commit> <folder> [--reinstall]
  local want=$1 out=$2 name=${2#"$repo/"}
  if [[ -d "$out/.git" ]] && [[ "$(git -C "$out" rev-parse HEAD)" == "$want"* ]]; then
    if [[ -f "$out/node_modules/.package-lock.json" && "${3:-}" != "--reinstall" ]]; then
      echo "$name is ready at ${want:0:12}"
      return 0
    fi
    echo "$name is already at $want"
  else
    rm -rf "$out"
    git init -q "$out"
    git -C "$out" remote add origin https://github.com/pblsketch/ieumoffice.git
    git -C "$out" fetch -q --depth 1 origin "$want"
    git -C "$out" -c advice.detachedHead=false checkout -q FETCH_HEAD
  fi
  echo "IeumOffice $(git -C "$out" rev-parse --short HEAD) ($(git -C "$out" log -1 --format=%cI)) → $name"
  (cd "$out" && npm install --ignore-scripts --no-audit --no-fund --loglevel=error)
}

pin_of() { sed -n 's/^commit: //p' "$1"; }
fetch "${1:-$(pin_of "$repo/vendor/ieumoffice.PINNED")}" "$repo/vendor/ieumoffice" "${2:-}"

# The parts that still build from an earlier pin (scripts/ieum-earlier-source.mjs): each switch's checkout, once.
switches="$repo/scripts/ieum-earlier-source.mjs"
fetched=" vendor/ieumoffice "
for part in HWP DRIVE; do
  dir=$(sed -n "s/^export const IEUM_${part}_DIR = '\(.*\)';$/\1/p" "$switches")
  pin=$(sed -n "s/^export const IEUM_${part}_PIN_FILE = '\(.*\)';$/\1/p" "$switches")
  [[ -n "$dir" && -n "$pin" ]] || { echo "$switches: the $part switch is not found" >&2; exit 1; }
  [[ "$fetched" == *" $dir "* ]] && continue
  fetch "$(pin_of "$repo/$pin")" "$repo/$dir"
  fetched+="$dir "
done
