#!/usr/bin/env bash
set -euo pipefail

repo="${T3_WEASEL_REPOSITORY:-morrowbyte/t3code}"
channel="${T3_WEASEL_CHANNEL:-nightly}"
base_dir="${T3_WEASEL_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/t3code-weasel}"
install_dir="$base_dir/versions"
current_link="$base_dir/current"
mode="${1:---update}"
managed="${T3_WEASEL_MANAGED:-0}"
die() { printf 't3code-weasel: %s\n' "$*" >&2; exit 1; }
valid_version() { [[ "$1" =~ ^[0-9A-Za-z][0-9A-Za-z.+_-]*$ ]]; }
installed_version() { if [[ -L "$current_link" ]]; then basename "$(readlink "$current_link")"; fi; }
valid_install() {
  local target
  target="$(readlink -f "$install_dir/$1" 2>/dev/null)" || return 1
  [[ "$target" == /nix/store/* && -x "$target/bin/t3code-weasel" ]]
}
point_to() {
  # Both the version link and current are in the same filesystem; rename is atomic.
  local next="$base_dir/.current.$$" previous
  previous="$(readlink "$current_link" 2>/dev/null || true)"
  if [[ -n "$previous" && "$previous" != "$install_dir/$1" ]]; then
    ln -s "$previous" "$base_dir/.previous.$$"
    mv -Tf "$base_dir/.previous.$$" "$base_dir/previous"
  fi
  ln -s "$install_dir/$1" "$next"
  mv -Tf "$next" "$current_link"
}

[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'invalid release repository'
[[ "$channel" == nightly || "$channel" == stable ]] || die 'channel must be nightly or stable'
[[ "$base_dir" == /* ]] || die 'data directory must be absolute'
case "$mode" in
  --status)
    printf 'Installed version: %s\nChannel: %s\nRepository: %s\n' "$(installed_version)" "$channel" "$repo"
    exit 0 ;;
  --rollback|--activate)
    version="${2:-}"
    [[ $# -eq 2 ]] && valid_version "$version" && valid_install "$version" || die 'activation requires an installed version'
    mkdir -p "$base_dir"
    exec 9>"$base_dir/.update.lock"
    flock -n 9 || die 'another update is running'
    if [[ "$mode" == --activate ]]; then
      [[ -f "$base_dir/prepared/$version.json" ]] || die 'version has not been prepared'
      [[ "$(jq -er '.storePath' "$base_dir/prepared/$version.json")" == "$(readlink -f "$install_dir/$version")" ]] || die 'prepared Store root changed'
    fi
    point_to "$version"
    printf 'Selected installed version %s; running processes unchanged.\n' "$version"
    exit 0 ;;
  --prepare) [[ $# -eq 2 ]] && valid_version "$2" || die 'prepare requires an exact version' ;;
  --update|--check) [[ $# -le 1 ]] || die 'unexpected arguments' ;;
  *) die 'usage: install.sh [--update|--check|--prepare VERSION|--activate VERSION|--status|--rollback VERSION]' ;;
esac
for tool in curl jq sha256sum nix-store zstd flock; do command -v "$tool" >/dev/null 2>&1 || die "required command not found: $tool"; done
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die 'this updater supports x86_64 Linux with Nix'
fetch() { curl --proto '=https' --fail --silent --show-error --location --connect-timeout 10 --max-time 1800 --retry 2 "$@"; }
releases_json="$(fetch "https://api.github.com/repos/$repo/releases?per_page=100")" || die 'could not read releases'
requested=""; [[ "$mode" != --prepare ]] || requested="$2"
release_json="$(jq -cer --arg channel "$channel" --arg requested "$requested" '[.[] | select(.draft == false) | select(
  if $channel == "nightly" then .prerelease == true and
    (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-nightly\\.[0-9]{8}\\.[0-9]+$")) and
    (.name | startswith("Weasel Nightly"))
  else .prerelease == false and (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.name | startswith("Weasel Stable")) end
) | select($requested == "" or .tag_name == ("v" + $requested))] | sort_by(.published_at) | last' <<<"$releases_json")" || die "no fork-owned $channel release found"
tag="$(jq -er '.tag_name' <<<"$release_json")"
version="${tag#v}"
valid_version "$version" || die 'invalid release version'
asset_name="T3-Code-$version-x86_64-linux-nix-closure.nar.zst"
manifest_name="T3-Code-$version-x86_64-linux-nix-closure.json"
# Both the manifest and archive must be assets on this exact release. Never fetch
# executable packaging code, evaluate a flake, build or substitute on the host.
asset_metadata() {
  jq -cer --arg name "$1" '[.assets[] | select(.name == $name)] | if length == 1 then .[0] else error("missing or duplicate asset") end' <<<"$release_json"
}
asset_url() {
  local metadata url
  metadata="$(asset_metadata "$1")" || die "release $tag lacks unique $1"
  url="$(jq -er '.browser_download_url' <<<"$metadata")"
  [[ "$url" == "https://github.com/$repo/releases/download/$tag/$1" ]] || die 'asset URL does not match selected repository/release'
  printf '%s' "$url"
}
asset_digest() {
  asset_metadata "$1" | jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$")) | sub("^sha256:"; "")'
}
manifest_url="$(asset_url "$manifest_name")"
manifest_digest="$(asset_digest "$manifest_name")" || die 'manifest asset lacks SHA-256'
archive_url="$(asset_url "$asset_name")"
archive_digest="$(asset_digest "$asset_name")" || die 'closure asset lacks SHA-256'
# Preserve the exact downloaded bytes for digest validation (command substitution
# removes trailing newlines), so fetch to a temporary file even for --check.
work_dir="$(mktemp -d)"; trap 'rm -rf -- "$work_dir"' EXIT
fetch "$manifest_url" --output "$work_dir/manifest.json"
[[ "$(sha256sum "$work_dir/manifest.json" | cut -d ' ' -f 1)" == "$manifest_digest" ]] || die 'closure manifest does not match SHA-256'
store_path="$(jq -er --arg version "$version" --arg asset "$asset_name" --arg digest "$archive_digest" '
  select(.schemaVersion == 1 and .version == $version and .system == "x86_64-linux" and .asset == $asset and .sha256 == $digest and .compression == "zstd") |
  .storePath | select(test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$"))' "$work_dir/manifest.json")" || die 'invalid closure manifest'
if [[ "$mode" == --check ]]; then
  jq -n --arg installed "$(installed_version)" --arg available "$version" --arg channel "$channel" --arg repository "$repo" \
    '{installed:$installed,available:$available,channel:$channel,repository:$repository,updateAvailable:($installed!=$available)}'
  exit 0
fi
mkdir -p "$base_dir" "$install_dir" "$base_dir/prepared" "$base_dir/.gcroots"
exec 9>"$base_dir/.update.lock"
flock -n 9 || die 'another update is running'
if ! valid_install "$version" || [[ "$(readlink -f "$install_dir/$version")" != "$store_path" ]]; then
  fetch "$archive_url" --output "$work_dir/closure.nar.zst"
  [[ "$(sha256sum "$work_dir/closure.nar.zst" | cut -d ' ' -f 1)" == "$archive_digest" ]] || die 'closure download does not match SHA-256'
  zstd --decompress --stdout "$work_dir/closure.nar.zst" | nix-store --import >"$work_dir/imported"
  [[ -x "$store_path/bin/t3code-weasel" ]] || die 'imported closure lacks the declared launcher'
fi
# Verify even a previously imported version before claiming it is prepared.
nix-store --query --requisites "$store_path" >"$work_dir/closure-paths"
while IFS= read -r path; do nix-store --verify-path "$path"; done <"$work_dir/closure-paths"
# --realise only registers an already imported root. Disable both builders and
# substitutions: missing outputs fail rather than compile on the destination.
nix-store --add-root "$base_dir/.gcroots/$(basename "$store_path")" --indirect \
  --realise "$store_path" --option max-jobs 0 --option builders '' --option substitute false >/dev/null
ln -s "$store_path" "$install_dir/.candidate.$$"
mv -Tf "$install_dir/.candidate.$$" "$install_dir/$version"
install -m 0600 "$work_dir/manifest.json" "$base_dir/prepared/.$version.$$"
mv -Tf "$base_dir/prepared/.$version.$$" "$base_dir/prepared/$version.json"
if [[ "$mode" == --prepare ]]; then
  printf 'Prepared %s; running version unchanged.\n' "$version"
  exit 0
fi
point_to "$version"
if [[ "$managed" != 1 ]]; then
  launcher_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$launcher_dir" "$desktop_dir"
  # Keep an existing user launcher: it may own a credential wrapper/profile.
  if [[ ! -e "$launcher_dir/t3code-weasel" ]]; then
    printf '#!/usr/bin/env bash\nset -euo pipefail\nexport T3CODE_HOME=%q\nexec %q "$@"\n' "$base_dir" "$current_link/bin/t3code-weasel" >"$work_dir/launcher"
    install -m 0755 "$work_dir/launcher" "$launcher_dir/t3code-weasel"
  fi
  if [[ ! -e "$desktop_dir/t3code-weasel.desktop" ]]; then
    cat >"$work_dir/desktop" <<DESKTOP
[Desktop Entry]
Name=T3 Code (Weasel Nightly)
Comment=AI coding assistant desktop app
Exec="$launcher_dir/t3code-weasel" %U
Icon=applications-development
Terminal=false
Type=Application
Categories=Development;IDE;
StartupWMClass=T3 Code
DESKTOP
    install -m 0644 "$work_dir/desktop" "$desktop_dir/t3code-weasel.desktop"
  fi
fi
printf 'Selected %s; the next launch uses this version. Running processes unchanged.\n' "$version"
