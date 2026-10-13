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
  --rollback)
    version="${2:-}"
    [[ $# -eq 2 ]] || die 'rollback requires exactly one version'
    if ! valid_version "$version" || ! valid_install "$version"; then die 'rollback requires an installed version'; fi
    mkdir -p "$base_dir"
    exec 9>"$base_dir/.update.lock"
    flock -n 9 || die 'another update is running'
    point_to "$version"
    printf 'Selected installed version %s; running processes unchanged.\n' "$version"
    exit 0 ;;
  --update|--check) [[ $# -le 1 ]] || die 'unexpected arguments' ;;
  *) die 'usage: install.sh [--update|--check|--status|--rollback VERSION]' ;;
esac
for tool in curl jq sha256sum nix nix-store flock; do command -v "$tool" >/dev/null 2>&1 || die "required command not found: $tool"; done
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die 'this updater supports x86_64 Linux with Nix'
fetch() { curl --proto '=https' --fail --silent --show-error --location --connect-timeout 10 --max-time 300 --retry 2 "$@"; }
releases_json="$(fetch "https://api.github.com/repos/$repo/releases?per_page=100")" || die 'could not read releases'
release_json="$(jq -cer --arg channel "$channel" '[.[] | select(.draft == false) | select(
  if $channel == "nightly" then .prerelease == true and
    (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-nightly\\.[0-9]{8}\\.[0-9]+$")) and
    (.name | startswith("Weasel Nightly"))
  else .prerelease == false and (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.name | startswith("Weasel Stable")) end
)] | sort_by(.published_at) | last' <<<"$releases_json")" || die "no fork-owned $channel release found"
tag="$(jq -er '.tag_name' <<<"$release_json")"
version="${tag#v}"
valid_version "$version" || die 'invalid release version'
asset_name="T3-Code-$version-x86_64.AppImage"
asset_url="$(jq -er --arg name "$asset_name" '.assets[] | select(.name == $name) | .browser_download_url' <<<"$release_json")" || die "release $tag lacks $asset_name"
[[ "$asset_url" == "https://github.com/$repo/releases/download/$tag/$asset_name" ]] || die 'asset URL does not match selected repository/release'
digest="$(jq -er --arg name "$asset_name" '.assets[] | select(.name == $name) | .digest | select(test("^sha256:[0-9a-f]{64}$")) | sub("^sha256:"; "")' <<<"$release_json")" || die 'release asset lacks a valid SHA-256'
if [[ "$mode" == --check ]]; then
  jq -n --arg installed "$(installed_version)" --arg available "$version" --arg channel "$channel" --arg repository "$repo" \
    '{installed:$installed,available:$available,channel:$channel,repository:$repository,updateAvailable:($installed!=$available)}'
  exit 0
fi
mkdir -p "$base_dir" "$install_dir"
exec 9>"$base_dir/.update.lock"
flock -n 9 || { printf 'Another update is already running.\n'; exit 0; }
if [[ "$(installed_version)" == "$version" ]] && valid_install "$version"; then
  printf 'Already installed: %s\n' "$version"
  exit 0
fi
work_dir="$(mktemp -d "$base_dir/.install.XXXXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$script_dir/flake.nix" ]]; then flake_dir="$script_dir"; else
  packaging_ref="${T3_WEASEL_PACKAGING_REF:-main}"
  [[ "$packaging_ref" =~ ^[A-Za-z0-9._-]+$ ]] || die 'invalid packaging reference'
  flake_dir="$work_dir/flake"; mkdir -p "$flake_dir"
  fetch "https://raw.githubusercontent.com/$repo/$packaging_ref/packaging/nixos/flake.nix" --output "$flake_dir/flake.nix"
fi
if ! valid_install "$version"; then
  appimage="$work_dir/$asset_name"
  fetch "$asset_url" --output "$appimage"
  [[ "$(sha256sum "$appimage" | cut -d ' ' -f 1)" == "$digest" ]] || die 'downloaded AppImage does not match SHA-256'
  export T3_WEASEL_VERSION="$version" T3_WEASEL_ARTIFACT_URL="$asset_url" T3_WEASEL_ARTIFACT_SHA256="$digest" T3_WEASEL_REPOSITORY="$repo"
  # Never replace an existing version's GC root before a successful build.
  candidate="$work_dir/package"
  nix build --no-write-lock-file --impure --print-out-paths --out-link "$candidate" "path:$flake_dir#t3code-weasel" >"$work_dir/build-path"
  package_path="$(readlink -f "$candidate")"
  [[ "$package_path" == /nix/store/* && -x "$package_path/bin/t3code-weasel" ]] || die 'Nix package did not produce its launcher'
  mkdir -p "$base_dir/.gcroots"
  nix-store --add-root "$base_dir/.gcroots/$(basename "$package_path")" --indirect -r "$package_path" >/dev/null
  ln -s "$package_path" "$install_dir/.candidate.$$"
  mv -Tf "$install_dir/.candidate.$$" "$install_dir/$version"
fi
point_to "$version"
if [[ "$managed" != 1 ]]; then
  launcher_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
  desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$launcher_dir" "$desktop_dir"
  # Use a fixed absolute data path; preserve legacy profile identity.
  printf '#!/usr/bin/env bash\nset -euo pipefail\nexport T3CODE_HOME=%q\nexec %q "$@"\n' "$base_dir" "$current_link/bin/t3code-weasel" >"$work_dir/launcher"
  install -m 0755 "$work_dir/launcher" "$launcher_dir/t3code-weasel"
  cat >"$work_dir/desktop" <<DESKTOP
[Desktop Entry]
Name=T3 Code (Weasel Nightly)
Comment=AI coding assistant desktop app
Exec=$launcher_dir/t3code-weasel %U
Icon=applications-development
Terminal=false
Type=Application
Categories=Development;IDE;
StartupWMClass=T3 Code
DESKTOP
  install -m 0644 "$work_dir/desktop" "$desktop_dir/t3code-weasel.desktop"
fi
printf 'Prepared %s; the next launch uses this version. Running processes unchanged.\n' "$version"
