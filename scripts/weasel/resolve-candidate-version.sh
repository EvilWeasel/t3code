#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: resolve-candidate-version.sh <full-lowercase-commit-sha>" >&2
  exit 2
fi

source_sha="$1"
base_version="$(git show "$source_sha:apps/desktop/package.json" | jq -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))')"
printf 'version=%s-pr.%s\n' "$base_version" "${source_sha:0:12}"
