#!/usr/bin/env bash
# Builds IeumOffice's xlsx engine (vendor/ieumoffice/apps/sheets/native/xlsx-engine, Rust) as
# WebAssembly for the spreadsheet editor's worker: apps/office/src/sheets/xlsx-engine.wasm.
# Needs Rust with the wasm32-wasip1 target (added if missing). The engine's C dependencies (bzip2
# and zstd, through IronCalc's zip) compile against the WASI sysroot, fetched once into the build
# cache and checked against its published SHA-256. The engine is built from a copy with a small
# patch for WASI (xlsx-wasm/wasi.patch). Does nothing when the wasm is newer than its inputs.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
engine="$repo/vendor/ieumoffice/apps/sheets/native/xlsx-engine"
crate="$here/xlsx-wasm"
out="$repo/apps/office/src/sheets/xlsx-engine.wasm"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/workbench-build"
sysroot_version=34
sysroot_sha256=9d813544eeebe38b7b8f2244ed591de46b6db812c6dd1a257ff9f0d2a905a2be
sysroot="$cache/wasi/sysroot-$sysroot_version"

[[ -d "$engine/src" ]] || { echo "vendor/ieumoffice is missing: run scripts/fetch-ieum.sh first" >&2; exit 1; }
if [[ -f "$out" && -z "$(find "$engine/src" "$engine/Cargo.toml" "$crate/src" "$crate/Cargo.toml" "$crate/wasi.patch" "$0" -newer "$out" -print -quit)" ]]; then
  echo "xlsx engine wasm is up to date"
  exit 0
fi

rustup target list --installed | grep -qx wasm32-wasip1 || rustup target add wasm32-wasip1
if [[ ! -d "$sysroot/include" ]]; then
  mkdir -p "$cache/wasi"
  archive="$cache/wasi/wasi-sysroot-$sysroot_version.0.tar.gz"
  curl -fsSL -o "$archive" "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$sysroot_version/wasi-sysroot-$sysroot_version.0.tar.gz"
  echo "$sysroot_sha256  $archive" | sha256sum -c --quiet
  mkdir -p "$sysroot"
  tar -xzf "$archive" -C "$sysroot" --strip-components=1
fi

# The engine copy, with its changes for WASI (xlsx-wasm/wasi.patch): no temporary folder (a
# workbook's cache goes under the worker's /tmp) and no threads (a sheet is indexed inline).
rm -rf "$crate/engine"
mkdir -p "$crate/engine"
cp -r "$engine/Cargo.toml" "$engine/src" "$crate/engine/"
patch --quiet --forward --no-backup-if-mismatch -p1 -d "$crate/engine" < "$crate/wasi.patch" || {
  echo "the xlsx engine changed: update $crate/wasi.patch" >&2
  exit 1
}

CFLAGS_wasm32_wasip1="--sysroot=$sysroot" CARGO_TARGET_DIR="$cache/xlsx-target" \
  cargo build --quiet --release --locked --target wasm32-wasip1 --manifest-path "$crate/Cargo.toml"
cp "$cache/xlsx-target/wasm32-wasip1/release/workbench_xlsx_wasm.wasm" "$out"
echo "xlsx engine wasm → $out ($(du -h "$out" | cut -f1))"
