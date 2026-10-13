#!/usr/bin/env bash
set -euo pipefail

repo='EvilWeasel/t3code'
asset_prefix='T3-Code-'
asset_suffix='-x86_64.AppImage'
base_dir="${XDG_DATA_HOME:-$HOME/.local/share}/t3code-weasel"
install_dir="$base_dir/versions"
current_link="$base_dir/current"
launcher_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
launcher="$launcher_dir/t3code-weasel"
desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
desktop_file="$desktop_dir/t3code-weasel.desktop"

die() { printf 't3code-weasel: %s\n' "$*" >&2; exit 1; }

for tool in curl jq sha256sum nix; do
  command -v "$tool" >/dev/null 2>&1 || die "required command not found: $tool"
done
[[ "$(uname -s)" == Linux ]] || die 'this installer supports Linux only'
[[ "$(uname -m)" == x86_64 ]] || die 'this installer currently supports x86_64 only'
releases_json="$(curl --fail --silent --show-error --location "https://api.github.com/repos/$repo/releases?per_page=100")" \
  || die 'could not read public fork releases'
release_json="$(jq -cer '[.[] | select(.draft == false and (.tag_name | test("weasel"; "i")))] | sort_by(.published_at) | last' <<<"$releases_json")" \
  || die 'no fork-owned Weasel prerelease found'
tag="$(jq -er '.tag_name' <<<"$release_json")" \
  || die 'selected release has no tag'
version="${tag#v}"
version="${version#weasel-}"
asset_name="$asset_prefix$version$asset_suffix"
asset_url="$(jq -er --arg name "$asset_name" '.assets[] | select(.name == $name) | .browser_download_url' <<<"$release_json")" \
  || die "release $tag does not contain $asset_name"
digest="$(jq -er --arg name "$asset_name" '.assets[] | select(.name == $name) | .digest | select(test("^sha256:[0-9a-f]{64}$")) | sub("^sha256:"; "")' <<<"$release_json")" \
  || die "release $tag has no valid SHA-256 for $asset_name"

mkdir -p "$base_dir" "$install_dir" "$launcher_dir" "$desktop_dir"
work_dir="$(mktemp -d "$base_dir/.install.XXXXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$script_dir/flake.nix" ]]; then
  flake_dir="$script_dir"
else
  packaging_ref="${T3_WEASEL_PACKAGING_REF:-main}"
  flake_dir="$work_dir/flake"
  mkdir -p "$flake_dir"
  curl --fail --silent --show-error --location \
    "https://raw.githubusercontent.com/$repo/$packaging_ref/packaging/nixos/flake.nix" \
    --output "$flake_dir/flake.nix" || die 'could not download the Nix package expression'
fi
appimage="$work_dir/$asset_name"
curl --fail --silent --show-error --location "$asset_url" --output "$appimage" \
  || die 'AppImage download failed'
actual="$(sha256sum "$appimage" | cut -d ' ' -f 1)"
[[ "$actual" == "$digest" ]] || die 'downloaded AppImage does not match the release SHA-256'

export T3_WEASEL_VERSION="$version"
export T3_WEASEL_ARTIFACT_URL="$asset_url"
export T3_WEASEL_ARTIFACT_SHA256="$digest"
version_path="$install_dir/$version"
if [[ -x "$version_path/bin/t3code-weasel" ]]; then
  package_path="$(readlink -f "$version_path")"
else
  rm -f -- "$version_path"
  nix build --no-write-lock-file --impure --print-out-paths \
    --out-link "$version_path" "path:$flake_dir#t3code-weasel" \
    >"$work_dir/build-path"
  package_path="$(readlink -f "$version_path")"
  [[ -x "$package_path/bin/t3code-weasel" ]] || die 'Nix package did not produce its launcher'
fi
ln -sfn "$version_path" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"

cat >"$work_dir/launcher" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
base_dir="${XDG_DATA_HOME:-$HOME/.local/share}/t3code-weasel"
export T3CODE_HOME="$base_dir"
exec "$base_dir/current/bin/t3code-weasel" "$@"
EOF
install -m 0755 "$work_dir/launcher" "$launcher"
cat >"$work_dir/desktop" <<EOF
[Desktop Entry]
Name=T3 Code (Weasel Nightly)
Comment=AI coding assistant desktop app
Exec=$launcher %U
Icon=applications-development
Terminal=false
Type=Application
Categories=Development;IDE;
StartupWMClass=T3 Code
EOF
install -m 0644 "$work_dir/desktop" "$desktop_file"
printf 'Installed T3 Code (Weasel Nightly) %s at %s\n' "$version" "$version_path"
printf 'Launch with: %s\n' "$launcher"
