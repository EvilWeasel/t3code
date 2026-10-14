#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT
fake_bin="$temp_dir/bin"
mkdir -p "$fake_bin"
export TEST_CLOSURE_ROOT="$temp_dir/store/00000000000000000000000000000000-t3code-weasel-0.0.45-pr.f1bf0f154d65"
export TEST_CLOSURE_DEP="$temp_dir/store/11111111111111111111111111111111-runtime-dep"
mkdir -p "$TEST_CLOSURE_ROOT/bin" "$TEST_CLOSURE_DEP"
printf '#!/bin/sh\nexit 0\n' > "$TEST_CLOSURE_ROOT/bin/t3code-weasel"
chmod +x "$TEST_CLOSURE_ROOT/bin/t3code-weasel"
cat > "$fake_bin/nix-store" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-} ${2:-}" in
  '--query --requisites')
    printf '%s\n%s\n' "$TEST_CLOSURE_ROOT" "$TEST_CLOSURE_DEP"
    ;;
  '--export '*|--export)
    printf 'fixture Nix export stream\n'
    ;;
  *) echo "unexpected nix-store args: $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$fake_bin/nix-store"
export PATH="$fake_bin:$PATH"

version='0.0.45-pr.f1bf0f154d65'
source_sha='0123456789abcdef0123456789abcdef01234567'
appimage_sha256='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
output_dir="$temp_dir/export"
bash "$script_dir/export-closure.sh" "$TEST_CLOSURE_ROOT" "$source_sha" "$appimage_sha256" "$version" "$output_dir"
(cd "$output_dir" && sha256sum --check SHA256SUMS)
gzip -dc "$output_dir/store-export.nix.gz" | cmp - <(printf 'fixture Nix export stream\n')
jq -e --arg root "$TEST_CLOSURE_ROOT" --arg source "$source_sha" \
  --arg appimage "$appimage_sha256" --arg export "$(sha256sum "$output_dir/store-export.nix.gz" | cut -d' ' -f1)" \
  --arg revision "$(sed -n 's#.*github:NixOS/nixpkgs/\([0-9a-f]\{40\}\).*#\1#p' "$script_dir/flake.nix")" \
  '.rootStorePath == $root and .sourceSha == $source and .appImageSha256 == $appimage and .storeExportSha256 == $export and .nixpkgsRevision == $revision and (.closurePaths | length == 2)' \
  "$output_dir/manifest.json" >/dev/null

if bash "$script_dir/export-closure.sh" "$TEST_CLOSURE_ROOT" "$source_sha" "$appimage_sha256" "$version" "$output_dir" >/dev/null 2>&1; then
  echo 'exporter unexpectedly replaced an existing bundle' >&2
  exit 1
fi
echo 'Nix closure export fixture passed (stubbed nix-store; no Nix build/import).'
