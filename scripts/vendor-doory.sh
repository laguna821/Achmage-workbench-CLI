#!/usr/bin/env bash
# Copy the doory web editor (https://github.com/shaongitbd/doory) into vendor/doory at a pinned commit.
# The vendored files are not edited: the design app (apps/design) adapts the editor from outside, through
# its EditorAdapter. Tests are left out; the licence files are kept as the Attribution Assurance License asks.
# Usage: scripts/vendor-doory.sh <commit-sha> [existing-clone]
set -euo pipefail

sha=${1:?usage: vendor-doory.sh <commit-sha> [existing-clone]}
repo=$(cd "$(dirname "$0")/.." && pwd)
out="$repo/vendor/doory"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [[ -n "${2:-}" ]]; then
  src=$2
else
  git clone --quiet --filter=blob:none https://github.com/shaongitbd/doory.git "$work/doory"
  src="$work/doory"
fi
git -C "$src" fetch --quiet --depth 1 origin "$sha" 2>/dev/null || true
git -C "$src" -c advice.detachedHead=false checkout --quiet "$sha"
date=$(git -C "$src" log -1 --format=%cI)

rm -rf "$out" && mkdir -p "$out"
cp -r "$src/frontend/src" "$out/src"
cp "$src/frontend/package.json" "$out/package.json"
cp "$src/frontend/tsconfig.app.json" "$out/tsconfig.app.json"
cp "$src/LICENSE" "$src/NOTICE" "$src/AUTHORS.md" "$src/THIRD_PARTY.md" "$out/"
mkdir -p "$out/licenses"
cp "$src/licenses/bundled-licenses.txt" "$src/licenses/DEPENDENCIES.md" "$src/licenses/siam-gpg.asc" "$out/licenses/"
find "$out/src" \( -name '*.test.ts' -o -name '*.test.tsx' \) -delete
rm -rf "$out/src/test"

cat > "$out/PINNED.md" <<EOF
# doory (vendored)

- Upstream: https://github.com/shaongitbd/doory
- Commit: $sha ($date)
- Contents: frontend/src without tests, frontend/package.json, licence files.
- Do not edit these files. Workbench adapts the editor from apps/design through its EditorAdapter.
- Licence: Attribution Assurance License (LICENSE, GPG-signed). Every launch must show
  "Doory by Siam, creator and maintainer of Doory, https://github.com/shaongitbd/doory".
EOF
echo "vendored doory $sha into $out"
