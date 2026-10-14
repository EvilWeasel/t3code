#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: resolve-candidate-version.sh <full-lowercase-commit-sha> [package.json]" >&2
  exit 2
fi

source_sha="$1"
package_json="${2:-apps/desktop/package.json}"
base_version="$(jq -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' "$package_json")"
printf 'version=%s-pr.%s\n' "$base_version" "${source_sha:0:12}"
