#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
source_sha=b99c008e037dbb97fcebb359517ad6f604ae6269
fixture="$(mktemp)"
trap 'rm -f "$fixture"' EXIT
printf '{"version":"0.0.45"}\n' > "$fixture"
actual="$(bash "$repo_root/scripts/weasel/resolve-candidate-version.sh" "$source_sha" "$fixture")"
[[ "$actual" == "version=0.0.45-pr.b99c008e037d" ]] || { echo "Unexpected pinned candidate version: $actual" >&2; exit 1; }

printf '{"version":"not-semver"}\n' > "$fixture"
if bash "$repo_root/scripts/weasel/resolve-candidate-version.sh" "$source_sha" "$fixture" >/dev/null 2>&1; then
  echo "Candidate version resolver accepted invalid package version." >&2
  exit 1
fi

printf '{"version":"1.2.3.4"}\n' > "$fixture"
if bash "$repo_root/scripts/weasel/resolve-candidate-version.sh" "$source_sha" "$fixture" >/dev/null 2>&1; then
  echo "Candidate version resolver accepted non-three-part semver." >&2
  exit 1
fi

for invalid in "${source_sha:0:39}" "${source_sha^^}" "not-a-sha"; do
  if bash "$repo_root/scripts/weasel/resolve-candidate-version.sh" "$invalid" >/dev/null 2>&1; then
    echo "Candidate version resolver accepted invalid SHA: $invalid" >&2
    exit 1
  fi
done

echo "Candidate version fixture passed for $source_sha and controlled package metadata."
