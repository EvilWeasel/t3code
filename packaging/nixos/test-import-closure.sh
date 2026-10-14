#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <already-built-package-store-path>" >&2
  exit 2
}
[[ $# == 1 ]] || usage
package_path="$(readlink -f "$1")"
[[ "$package_path" =~ ^/nix/store/[0-9a-z]{32}-t3code-weasel- ]] \
  || { echo 'test input must be a t3code-weasel Nix store path' >&2; exit 1; }
[[ -x "$package_path/bin/t3code-weasel" ]] || { echo 'package launcher is missing' >&2; exit 1; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT
fake_bin="$temp_dir/bin"
mkdir -p "$fake_bin"

version="${package_path##*-t3code-weasel-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.+_-]*)?$ ]] \
  || { echo 'test package has an unexpected version' >&2; exit 1; }
source_sha='0123456789abcdef0123456789abcdef01234567'
appimage_sha256='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
closure_paths="$(nix-store --query --requisites "$package_path")"
closure_paths_json="$(printf '%s\n' "$closure_paths" | jq -Rsc 'split("\n") | map(select(length > 0))')"
nixpkgs_revision="$(sed -n 's#.*github:NixOS/nixpkgs/\([0-9a-f]\{40\}\).*#\1#p' "$script_dir/flake.nix")"
bundle_dir="$temp_dir/bundle"
mkdir -p "$bundle_dir"
printf 'stub-only import stream\n' | gzip -n -9 > "$bundle_dir/store-export.nix.gz"
jq -n \
  --arg format 't3code-nixos-store-export-v1' \
  --arg version "$version" \
  --arg sourceSha "$source_sha" \
  --arg appImageSha256 "$appimage_sha256" \
  --arg nixpkgsRevision "$nixpkgs_revision" \
  --arg rootStorePath "$package_path" \
  --argjson closurePaths "$closure_paths_json" \
  '{format:$format,version:$version,sourceSha:$sourceSha,appImageSha256:$appImageSha256,nixpkgsRevision:$nixpkgsRevision,rootStorePath:$rootStorePath,closurePaths:$closurePaths}' \
  > "$bundle_dir/manifest.json"
(cd "$bundle_dir" && sha256sum manifest.json store-export.nix.gz > SHA256SUMS)
manifest_sha256="$(sha256sum "$bundle_dir/manifest.json")"
manifest_sha256="${manifest_sha256%% *}"

export TEST_CLOSURE_ROOT="$package_path"
export TEST_CLOSURE_PATHS="$closure_paths"
export TEST_IMPORT_CAPTURE="$temp_dir/imported-stream"
cat > "$fake_bin/nix-store" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-}" in
  '--import ')
    cat > "$TEST_IMPORT_CAPTURE"
    ;;
  '--query --requisites')
    [[ "${3:-}" == "$TEST_CLOSURE_ROOT" ]] || { echo 'unexpected query root' >&2; exit 2; }
    printf '%s\n' "$TEST_CLOSURE_PATHS"
    ;;
  '--add-root '*)
    args=("$@")
    root_index=-1
    for i in "${!args[@]}"; do
      if [[ "${args[$i]}" == --add-root ]]; then root_index=$((i + 1)); fi
    done
    [[ "$root_index" -gt 0 ]] || { echo 'missing add-root path' >&2; exit 2; }
    target="${args[-1]}"
    [[ "$target" == "$TEST_CLOSURE_ROOT" ]] || { echo 'unexpected GC root target' >&2; exit 2; }
    if [[ ! -e "${args[$root_index]}" && ! -L "${args[$root_index]}" ]]; then
      ln -s "$target" "${args[$root_index]}"
    fi
    ;;
  *) echo "unexpected nix-store args: $*" >&2; exit 2 ;;
esac
EOF
chmod 0755 "$fake_bin/nix-store"
export PATH="$fake_bin:$PATH"

home="$temp_dir/home"
data_dir="$home/.local/share/t3code-weasel"
bin_dir="$home/.local/bin"
share_dir="$home/.local/share"
launcher="$bin_dir/t3code-weasel"
desktop="$share_dir/applications/t3code-weasel.desktop"
old_version='0.0.46-nightly.20261013.3000'
old_path="$data_dir/versions/$old_version"
mkdir -p "$data_dir/versions" "$bin_dir" "$share_dir/applications"
ln -s "$package_path" "$old_path"
ln -s "$old_path" "$data_dir/current"
printf '#!/bin/sh\n# private credential-aware launcher sentinel\nexit 91\n' > "$launcher"
chmod 0710 "$launcher"
printf '[Desktop Entry]\n# private desktop sentinel\n' > "$desktop"
chmod 0600 "$desktop"
launcher_hash_before="$(sha256sum "$launcher")"; launcher_hash_before="${launcher_hash_before%% *}"
launcher_mode_before="$(stat -c '%a' "$launcher")"
desktop_hash_before="$(sha256sum "$desktop")"; desktop_hash_before="${desktop_hash_before%% *}"
desktop_mode_before="$(stat -c '%a' "$desktop")"
old_current="$(readlink "$data_dir/current")"

HOME="$home" XDG_DATA_HOME="$share_dir" XDG_BIN_HOME="$bin_dir" \
  T3_WEASEL_DATA_DIR="$data_dir" \
  bash "$script_dir/import-closure.sh" "$bundle_dir" "$source_sha" "$appimage_sha256" "$manifest_sha256"

[[ "$(readlink "$data_dir/current")" == "$data_dir/versions/$version" ]]
[[ "$(readlink "$data_dir/previous")" == "$old_current" ]]
[[ "$(readlink -f "$data_dir/versions/$version")" == "$package_path" ]]
[[ "$(readlink -f "$data_dir/.gcroots/$(basename "$package_path")")" == "$package_path" ]]
[[ "$(sha256sum "$launcher")" == "$launcher_hash_before  $launcher" ]]
[[ "$(stat -c '%a' "$launcher")" == "$launcher_mode_before" ]]
[[ "$(sha256sum "$desktop")" == "$desktop_hash_before  $desktop" ]]
[[ "$(stat -c '%a' "$desktop")" == "$desktop_mode_before" ]]
[[ "$(gzip -dc "$bundle_dir/store-export.nix.gz")" == "$(cat "$TEST_IMPORT_CAPTURE")" ]]
[[ ! -e "$data_dir/current.next" && ! -e "$data_dir/previous.next" ]]

HOME="$home" XDG_DATA_HOME="$share_dir" XDG_BIN_HOME="$bin_dir" \
  T3_WEASEL_DATA_DIR="$data_dir" \
  bash "$script_dir/install.sh" --rollback "$old_version" >/dev/null
[[ "$(readlink "$data_dir/current")" == "$old_current" ]]
[[ "$(readlink "$data_dir/previous")" == "$data_dir/versions/$version" ]]
[[ "$(sha256sum "$launcher")" == "$launcher_hash_before  $launcher" ]]
[[ "$(stat -c '%a' "$launcher")" == "$launcher_mode_before" ]]

# An absent launcher is created, while the existing private launcher above was kept byte-for-byte.
rm "$launcher"
HOME="$home" XDG_DATA_HOME="$share_dir" XDG_BIN_HOME="$bin_dir" \
  T3_WEASEL_DATA_DIR="$data_dir" \
  bash "$script_dir/import-closure.sh" "$bundle_dir" "$source_sha" "$appimage_sha256" "$manifest_sha256" >/dev/null
[[ -x "$launcher" ]]
grep -Fq 'export T3CODE_HOME=' "$launcher"
printf 'Nix closure import/launcher preservation fixture passed (stubbed nix-store import; no profile or DB writes).\n'
