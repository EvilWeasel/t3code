#!/usr/bin/env bash
set -euo pipefail

# Run only on the release builder. Hosts import the result without evaluating
# Nix expressions or building a package themselves.
[[ $# == 3 ]] || { echo "Usage: $0 VERSION APPIMAGE OUTPUT_DIR" >&2; exit 2; }
version="$1"
appimage="$(realpath "$2")"
output_dir="$3"
repo="${T3_WEASEL_REPOSITORY:-morrowbyte/t3code}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]] || exit 2
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 2
[[ "$(basename "$appimage")" == "T3-Code-$version-x86_64.AppImage" && -s "$appimage" ]] || exit 2
mkdir -p "$output_dir"
output_dir="$(realpath "$output_dir")"
asset="T3-Code-$version-x86_64-linux-nix-closure.nar.zst"
manifest="${asset%.nar.zst}.json"
work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

export T3_WEASEL_VERSION="$version" T3_WEASEL_REPOSITORY="$repo"
export T3_WEASEL_ARTIFACT_URL="https://github.com/$repo/releases/download/v$version/$(basename "$appimage")"
export T3_WEASEL_ARTIFACT_SHA256="$(sha256sum "$appimage" | cut -d ' ' -f 1)"
# fetchurl uses this fixed-output path. Seed it before the draft release exists.
nix-store --add-fixed sha256 "$appimage" >/dev/null
nix build --extra-experimental-features 'nix-command flakes' \
  --no-write-lock-file --impure --out-link "$work_dir/package" \
  path:./packaging/nixos#t3code-weasel
store_path="$(readlink -f "$work_dir/package")"
[[ "$store_path" == /nix/store/* && -x "$store_path/bin/t3code-weasel" ]]
mapfile -t closure_paths < <(nix-store --query --requisites "$store_path")
[[ ${#closure_paths[@]} -gt 0 ]]
nix-store --export "${closure_paths[@]}" | zstd -T0 -3 > "$output_dir/$asset"
zstd --test "$output_dir/$asset"
# Exercise the exact consumer transport on the builder as well. Importing
# existing store paths is harmless and catches malformed export streams.
zstd --decompress --stdout "$output_dir/$asset" | nix-store --import > "$work_dir/imported"
grep -Fxq "$store_path" "$work_dir/imported"
sha256="$(sha256sum "$output_dir/$asset" | cut -d ' ' -f 1)"
jq -n --arg version "$version" --arg storePath "$store_path" \
  --arg asset "$asset" --arg sha256 "$sha256" \
  '{schemaVersion:1,version:$version,system:"x86_64-linux",storePath:$storePath,asset:$asset,sha256:$sha256,compression:"zstd"}' \
  > "$output_dir/$manifest"
bash scripts/weasel/verify-nixos-closure.sh "$version" "$output_dir"
