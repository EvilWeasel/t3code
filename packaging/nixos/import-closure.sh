#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <verified-closure-bundle-dir> <qualified-source-sha> <qualified-appimage-sha256> <qualified-manifest-sha256>" >&2
  exit 2
}

[[ $# == 4 ]] || usage
bundle_dir="$1"
expected_source_sha="$2"
expected_appimage_sha256="$3"
expected_manifest_sha256="$4"

die() { printf 't3code-weasel install: %s\n' "$*" >&2; exit 1; }

[[ "$expected_source_sha" =~ ^[0-9a-f]{40}$ ]] || die 'source SHA must be 40 lowercase hex characters'
[[ "$expected_appimage_sha256" =~ ^[0-9a-f]{64}$ ]] || die 'AppImage SHA-256 must be 64 lowercase hex characters'
[[ "$expected_manifest_sha256" =~ ^[0-9a-f]{64}$ ]] || die 'qualified manifest SHA-256 must be 64 lowercase hex characters'
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die 'this closure supports x86_64 Linux only'
[[ -d "$bundle_dir" ]] || die 'closure bundle directory does not exist'

for tool in gzip sha256sum jq nix-store sort cmp diff grep wc readlink mktemp install mv ln uname; do
  command -v "$tool" >/dev/null 2>&1 || die "required command not found: $tool"
done

for file in manifest.json SHA256SUMS store-export.nix.gz; do
  [[ -f "$bundle_dir/$file" && ! -L "$bundle_dir/$file" ]] || die "bundle is missing regular file $file"
done
[[ "$(wc -l < "$bundle_dir/SHA256SUMS")" -eq 2 ]] || die 'SHA256SUMS must contain exactly two entries'
grep -Eq '^[0-9a-f]{64}  manifest\.json$' "$bundle_dir/SHA256SUMS" || die 'SHA256SUMS has no manifest entry'
grep -Eq '^[0-9a-f]{64}  store-export\.nix\.gz$' "$bundle_dir/SHA256SUMS" || die 'SHA256SUMS has no store export entry'
(cd "$bundle_dir" && sha256sum --check --strict SHA256SUMS) || die 'bundle checksum validation failed'

manifest="$bundle_dir/manifest.json"
actual_manifest_sha256="$(sha256sum "$manifest")"
actual_manifest_sha256="${actual_manifest_sha256%% *}"
[[ "$actual_manifest_sha256" == "$expected_manifest_sha256" ]] \
  || die 'bundle manifest does not match the independently qualified manifest digest'
[[ "$(jq -er '.format' "$manifest")" == t3code-nixos-store-export-v1 ]] || die 'unsupported closure manifest format'
source_sha="$(jq -er '.sourceSha' "$manifest")"
appimage_sha256="$(jq -er '.appImageSha256' "$manifest")"
store_export_sha256="$(jq -er '.storeExportSha256 | select(type == "string")' "$manifest")" \
  || die 'manifest is missing the compressed store export digest'
version="$(jq -er '.version' "$manifest")"
root_store_path="$(jq -er '.rootStorePath' "$manifest")"
[[ "$source_sha" == "$expected_source_sha" ]] || die 'bundle source SHA does not match the qualified source'
[[ "$appimage_sha256" == "$expected_appimage_sha256" ]] || die 'bundle AppImage digest does not match the qualified release'
[[ "$store_export_sha256" =~ ^[0-9a-f]{64}$ ]] || die 'manifest store export SHA-256 is invalid'
actual_store_export_sha256="$(sha256sum "$bundle_dir/store-export.nix.gz")"
actual_store_export_sha256="${actual_store_export_sha256%% *}"
[[ "$actual_store_export_sha256" == "$store_export_sha256" ]] \
  || die 'compressed Nix store export does not match the qualified manifest'
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.+_-]*)?$ ]] || die 'bundle version has an unexpected format'
[[ "$root_store_path" =~ ^/nix/store/[0-9a-z]{32}-t3code-weasel-${version}$ ]] || die 'manifest root path does not match the package version'
jq -e --arg root "$root_store_path" \
  '(.closurePaths | type == "array" and length > 0) and all(.closurePaths[]; type == "string" and startswith("/nix/store/")) and (.closurePaths | index($root) != null)' \
  "$manifest" >/dev/null || die 'manifest closure paths are invalid'

# The qualified manifest binds the compressed export digest. Verify it before
# nix-store sees the stream; no derivation or package build runs here.
gzip -dc "$bundle_dir/store-export.nix.gz" | nix-store --import \
  || die 'Nix store import failed'
actual_closure="$(nix-store --query --requisites "$root_store_path" | LC_ALL=C sort)" \
  || die 'imported root path is not valid in the local Nix store'
expected_closure="$(jq -r '.closurePaths[]' "$manifest" | LC_ALL=C sort)"
diff -u <(printf '%s\n' "$expected_closure") <(printf '%s\n' "$actual_closure") \
  || die 'imported store closure differs from the receipt'
[[ -x "$root_store_path/bin/t3code-weasel" ]] || die 'imported package launcher is missing'

base_dir="${T3_WEASEL_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/t3code-weasel}"
install_dir="$base_dir/versions"
current_link="$base_dir/current"
previous_link="$base_dir/previous"
gc_root_dir="$base_dir/.gcroots"
launcher_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
launcher="$launcher_dir/t3code-weasel"
desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
desktop_file="$desktop_dir/t3code-weasel.desktop"
version_path="$install_dir/$version"
gc_root="$gc_root_dir/$(basename "$root_store_path")"
mkdir -p "$install_dir" "$gc_root_dir" "$launcher_dir" "$desktop_dir"

if [[ -e "$version_path" || -L "$version_path" ]]; then
  [[ "$(readlink -f "$version_path")" == "$root_store_path" ]] \
    || die "version $version is already rooted to a different store path"
fi
if [[ -e "$gc_root" || -L "$gc_root" ]]; then
  [[ "$(readlink -f "$gc_root")" == "$root_store_path" ]] \
    || die 'existing Nix GC root points to a different store path'
else
  nix-store --add-root "$gc_root" --indirect -r "$root_store_path" >/dev/null \
    || die 'could not register the imported version as a Nix GC root'
fi

if [[ ! -e "$version_path" && ! -L "$version_path" ]]; then
  ln -s "$root_store_path" "$install_dir/.candidate.$$"
  mv -Tf "$install_dir/.candidate.$$" "$version_path"
fi

if [[ -L "$current_link" ]]; then
  old_version="$(readlink "$current_link")"
  if [[ "$old_version" != "$version_path" ]]; then
    ln -sfn "$old_version" "$previous_link.next"
    mv -Tf "$previous_link.next" "$previous_link"
  fi
fi
if [[ -e "$launcher" || -L "$launcher" ]]; then
  printf 'Preserving existing launcher: %s\n' "$launcher"
else
  launcher_tmp="$(mktemp "$launcher_dir/.t3code-weasel.XXXXXXXX")"
  cat > "$launcher_tmp" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export T3CODE_HOME=$(printf '%q' "$base_dir")
exec $(printf '%q' "$current_link/bin/t3code-weasel") "\$@"
EOF
  chmod 0755 "$launcher_tmp"
  if ! ln "$launcher_tmp" "$launcher" 2>/dev/null; then
    [[ -e "$launcher" || -L "$launcher" ]] || die 'could not create the launcher'
    printf 'Preserving launcher created concurrently: %s\n' "$launcher"
  fi
  rm -f -- "$launcher_tmp"
fi
if [[ -e "$desktop_file" || -L "$desktop_file" ]]; then
  printf 'Preserving existing desktop entry: %s\n' "$desktop_file"
else
  desktop_tmp="$(mktemp "$desktop_dir/.t3code-weasel.XXXXXXXX")"
  cat > "$desktop_tmp" <<EOF
[Desktop Entry]
Name=T3 Code (Weasel Nightly)
Comment=AI coding assistant desktop app
Exec="$launcher" %U
Icon=applications-development
Terminal=false
Type=Application
Categories=Development;IDE;
StartupWMClass=T3 Code
EOF
  chmod 0644 "$desktop_tmp"
  if ! ln "$desktop_tmp" "$desktop_file" 2>/dev/null; then
    [[ -e "$desktop_file" || -L "$desktop_file" ]] || die 'could not create the desktop entry'
    printf 'Preserving desktop entry created concurrently: %s\n' "$desktop_file"
  fi
  rm -f -- "$desktop_tmp"
fi
ln -sfn "$version_path" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"
printf 'Installed verified T3 Code (Weasel Nightly) %s from %s\n' "$version" "$root_store_path"
