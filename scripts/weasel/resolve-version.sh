#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: resolve-version.sh <upstream-base-version> <YYYYMMDD> <run-number>" >&2
  exit 2
fi

base_version="$1"
date="$2"
run_number="$3"
if [[ ! "$base_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "Invalid upstream base version: $base_version" >&2
  exit 2
fi
major="${BASH_REMATCH[1]}"
minor="${BASH_REMATCH[2]}"
patch="${BASH_REMATCH[3]}"
if [[ ! "$date" =~ ^[0-9]{8}$ || ! "$run_number" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid nightly date or run number." >&2
  exit 2
fi

# Stay ahead of the upstream app version while retaining the standard nightly
# channel form understood by both the build script and electron-updater.
next_patch=$((10#$patch + 1))
printf 'version=%s.%s.%s-nightly.%s.%s\n' "$major" "$minor" "$next_patch" "$date" "$run_number"
