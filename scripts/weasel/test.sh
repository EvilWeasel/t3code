#!/usr/bin/env bash
set -euo pipefail

bash -n scripts/weasel/*.sh
bash scripts/weasel/sync-upstream-nightly.test.sh
bash scripts/weasel/verify-desktop-source.test.sh
actual="$(bash scripts/weasel/resolve-version.sh 0.0.46 20261013 1)"
if [[ "$actual" != "version=0.0.47-nightly.20261013.1" ]]; then
  echo "Unexpected fork version: $actual" >&2
  exit 1
fi

if bash scripts/weasel/resolve-version.sh invalid 20261013 1 >/dev/null 2>&1; then
  echo "Invalid base versions must be rejected." >&2
  exit 1
fi

run_date="$(bash scripts/weasel/resolve-run-date.sh 2026-10-13T23:59:58Z)"
if [[ "$run_date" != "20261013" ]]; then
  echo "Release date must come from the immutable workflow run creation time." >&2
  exit 1
fi

bash scripts/weasel/verify-published-release.test.sh
bash scripts/weasel/read-draft-release-assets.test.sh
bash scripts/weasel/verify-nixos-closure.test.sh
