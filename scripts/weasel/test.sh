#!/usr/bin/env bash
set -euo pipefail

bash -n scripts/weasel/*.sh
actual="$(bash scripts/weasel/resolve-version.sh 0.0.46 20261013 1)"
if [[ "$actual" != "version=0.0.47-nightly.20261013.1" ]]; then
  echo "Unexpected fork version: $actual" >&2
  exit 1
fi

if bash scripts/weasel/resolve-version.sh invalid 20261013 1 >/dev/null 2>&1; then
  echo "Invalid base versions must be rejected." >&2
  exit 1
fi
