#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <package-store-path> <source-sha> <appimage-sha256> <version> <output-dir>" >&2
  exit 2
}

[[ $# == 5 ]] || usage
package_path="$1"
source_sha="$2"
appimage_sha256="$3"
version="$4"
output_dir="$5"

die() { printf 'nixos closure export: %s\n' "$*" >&2; exit 1; }

[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || die 'source SHA must be 40 lowercase hex characters'
[[ "$appimage_sha256" =~ ^[0-9a-f]{64}$ ]] || die 'AppImage SHA-256 must be 64 lowercase hex characters'
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.+_-]*)?$ ]] \
  || die 'version must be a safe semver version or prerelease'
[[ "$(basename "$package_path")" == *-t3code-weasel-"$version" ]] \
  || die 'package path does not match the requested version'
[[ -x "$package_path/bin/t3code-weasel" ]] || die 'package launcher is missing or not executable'
[[ ! -e "$output_dir" && ! -L "$output_dir" ]] || die 'output directory already exists'

for tool in nix-store gzip sha256sum jq sort; do
  command -v "$tool" >/dev/null 2>&1 || die "required command not found: $tool"
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
nixpkgs_revision="$(sed -n 's#.*github:NixOS/nixpkgs/\([0-9a-f]\{40\}\).*#\1#p' "$script_dir/flake.nix")"
[[ "$nixpkgs_revision" =~ ^[0-9a-f]{40}$ ]] || die 'could not read pinned nixpkgs revision'

closure_output="$(nix-store --query --requisites "$package_path")" \
  || die 'could not enumerate the package closure'
mapfile -t closure_paths < <(printf '%s\n' "$closure_output" | LC_ALL=C sort -u)
((${#closure_paths[@]} > 0)) || die 'package closure is empty'
printf '%s\n' "${closure_paths[@]}" | grep -Fxq -- "$package_path" \
  || die 'enumerated closure does not contain the package path'

output_parent="$(dirname "$output_dir")"
mkdir -p "$output_parent"
staging_dir="$(mktemp -d "$output_parent/.nixos-closure.XXXXXXXX")"
trap 'rm -rf -- "$staging_dir"' EXIT

nix-store --export "${closure_paths[@]}" | gzip -n -9 > "$staging_dir/store-export.nix.gz" \
  || die 'could not export the Nix store closure'
store_export_sha256="$(sha256sum "$staging_dir/store-export.nix.gz")"
store_export_sha256="${store_export_sha256%% *}"
closure_paths_json="$(printf '%s\n' "${closure_paths[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
jq -n \
  --arg format 't3code-nixos-store-export-v1' \
  --arg version "$version" \
  --arg sourceSha "$source_sha" \
  --arg appImageSha256 "$appimage_sha256" \
  --arg storeExportSha256 "$store_export_sha256" \
  --arg nixpkgsRevision "$nixpkgs_revision" \
  --arg rootStorePath "$package_path" \
  --argjson closurePaths "$closure_paths_json" \
  '{format:$format,version:$version,sourceSha:$sourceSha,appImageSha256:$appImageSha256,storeExportSha256:$storeExportSha256,nixpkgsRevision:$nixpkgsRevision,rootStorePath:$rootStorePath,closurePaths:$closurePaths}' \
  > "$staging_dir/manifest.json"
(cd "$staging_dir" && sha256sum manifest.json store-export.nix.gz > SHA256SUMS)
manifest_sha256="$(sha256sum "$staging_dir/manifest.json")"
manifest_sha256="${manifest_sha256%% *}"
mv -- "$staging_dir" "$output_dir"
trap - EXIT
printf 'Exported %s store paths for %s to %s\n' "${#closure_paths[@]}" "$version" "$output_dir"
printf 'Qualified manifest SHA-256: %s\n' "$manifest_sha256"
