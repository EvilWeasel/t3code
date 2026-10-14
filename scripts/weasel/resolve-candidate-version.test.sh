#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
source_sha=72aa65d56601f3318cfaa7c05dbf93e936f2b575
actual="$(bash "$repo_root/scripts/weasel/resolve-candidate-version.sh" "$source_sha")"
[[ "$actual" == "version=0.0.45-pr.72aa65d56601" ]] || { echo "Unexpected pinned candidate version: $actual" >&2; exit 1; }

for invalid in "${source_sha:0:39}" "${source_sha^^}" "not-a-sha"; do
  if bash "$repo_root/scripts/weasel/resolve-candidate-version.sh" "$invalid" >/dev/null 2>&1; then
    echo "Candidate version resolver accepted invalid SHA: $invalid" >&2
    exit 1
  fi
done

echo "Candidate version fixture passed for $source_sha."
