#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <actions-run-created-at-iso8601>" >&2
  exit 2
fi

run_created_at="$1"
if ! release_date="$(date -u -d "$run_created_at" +%Y%m%d 2>/dev/null)" ||
  [[ ! "$release_date" =~ ^[0-9]{8}$ ]]; then
  echo "Invalid GitHub Actions run created_at timestamp: $run_created_at" >&2
  exit 1
fi

printf '%s\n' "$release_date"
