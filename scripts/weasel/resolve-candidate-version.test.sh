#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
source_sha=f1bf0f154d65782dcad4f2ebf01dc258e205bd8d
fixture="$(mktemp)"
trap 'rm -f "$fixture"' EXIT
printf '{"version":"0.0.45"}\n' > "$fixture"
actual="$(bash "$repo_root/scripts/weasel/resolve-candidate-version.sh" "$source_sha" "$fixture")"
[[ "$actual" == "version=0.0.45-pr.f1bf0f154d65" ]] || { echo "Unexpected pinned candidate version: $actual" >&2; exit 1; }

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
