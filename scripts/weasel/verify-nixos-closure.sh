#!/usr/bin/env bash
set -euo pipefail
[[ $# == 2 ]] || { echo "Usage: $0 VERSION ASSETS_DIR" >&2; exit 2; }
version="$1"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]] || exit 2
directory="$2"
asset="T3-Code-$version-x86_64-linux-nix-closure.nar.zst"
manifest="$directory/${asset%.nar.zst}.json"
[[ -s "$directory/$asset" && -s "$manifest" ]]
jq -e --arg version "$version" --arg asset "$asset" '
  .schemaVersion == 1 and .version == $version and .system == "x86_64-linux" and
  .compression == "zstd" and .asset == $asset and
  (.storePath | test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$")) and
  (.sha256 | test("^[0-9a-f]{64}$"))
' "$manifest" >/dev/null
expected="$(jq -r .sha256 "$manifest")"
actual="$(sha256sum "$directory/$asset" | cut -d ' ' -f 1)"
[[ "$expected" == "$actual" ]]
