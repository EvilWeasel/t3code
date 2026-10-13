#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: install-linux.sh <downloaded-AppImage>" >&2
  exit 2
fi

source_image="$(realpath "$1")"
if [[ ! -f "$source_image" ]]; then
  echo "AppImage not found: $source_image" >&2
  exit 1
fi

if [[ -r /etc/os-release ]] && grep -Eiq '^(ID|ID_LIKE)=([^\n]*[" ]|)nixos([" ]|$)' /etc/os-release; then
  release_repository="${WEASEL_RELEASE_REPOSITORY:-morrowbyte/t3code}"
  cat >&2 <<'EOF'
This AppImage installer does not support NixOS. Use the dedicated NixOS
package and user updater launcher documented at:
EOF
  printf 'https://github.com/%s/tree/main/packaging/nixos\n' "$release_repository" >&2
  exit 1
fi

install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/weasel-t3code"
applications_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$install_dir" "$applications_dir"
install -m 0755 "$source_image" "$install_dir/T3-Code-Weasel.AppImage"
cat > "$applications_dir/com.evilweasel.T3Code.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=T3 Code (Weasel Nightly)
Comment=Desktop GUI for coding agents
Exec=$install_dir/T3-Code-Weasel.AppImage %U
Icon=applications-development
Terminal=false
Categories=Development;IDE;
MimeType=x-scheme-handler/t3code;
EOF
chmod 0644 "$applications_dir/com.evilweasel.T3Code.desktop"
printf 'Installed user-local AppImage at %s\n' "$install_dir/T3-Code-Weasel.AppImage"
