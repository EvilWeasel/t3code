#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <tag> <source-sha> <version> <expected-assets-dir>" >&2
  exit 2
fi

tag="$1"
source_sha="$2"
version="$3"
expected_dir="$4"
repo="${GH_REPO:-EvilWeasel/t3code}"
git_remote="${WEASEL_VERIFY_GIT_REMOTE:-origin}"

fail() {
  echo "Published release verification failed: $*" >&2
  exit 1
}

[[ -d "$expected_dir" ]] || fail "expected asset directory is missing: $expected_dir"

git fetch --no-tags "$git_remote" "refs/tags/$tag:refs/weasel-verify/published-tag"
resolved_sha="$(git rev-parse 'refs/weasel-verify/published-tag^{commit}')"
[[ "$resolved_sha" == "$source_sha" ]] ||
  fail "tag $tag resolves to $resolved_sha instead of source $source_sha"

release_json="$(gh api "repos/$repo/releases/tags/$tag")"
jq -e --arg tag "$tag" '.tag_name == $tag and .draft == false and .prerelease == true' \
  <<<"$release_json" >/dev/null || fail "release metadata does not identify a published prerelease for $tag"

assets_json="$(jq -c '[.assets[] | {name, digest}]' <<<"$release_json")"
jq -e 'length > 0 and all(.[]; (.digest | type == "string") and (.digest | startswith("sha256:")))' \
  <<<"$assets_json" >/dev/null || fail "GitHub asset digests are missing"

download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT
gh release download "$tag" --dir "$download_dir" --repo "$repo"

for required in \
  nightly-linux.yml \
  nightly.yml \
  weasel-linux-x64.tar.gz \
  "T3-Code-$version-x86_64.AppImage" \
  "T3-Code-$version-x86_64-linux-nix-closure.nar.zst" \
  "T3-Code-$version-x86_64-linux-nix-closure.json" \
  install-linux.sh \
  "t3-$version-linux-x64.tar.gz" \
  "t3-$version-win32-x64.zip" \
  SHA256SUMS \
  RELEASE-RECEIPT.txt; do
  [[ -s "$download_dir/$required" ]] || fail "required asset is missing: $required"
done

expected_names="$(find "$expected_dir" -maxdepth 1 -type f ! -name 'RELEASE-RECEIPT.txt' -printf '%f\n' | sort)"
expected_names+=$'\nRELEASE-RECEIPT.txt'
actual_names="$(find "$download_dir" -maxdepth 1 -type f -printf '%f\n' | sort)"
[[ "$actual_names" == "$(sort <<<"$expected_names")" ]] ||
  fail "published asset names do not match this run's expected asset set"

cmp -s "$expected_dir/SHA256SUMS" "$download_dir/SHA256SUMS" ||
  fail "published SHA256SUMS differs from this run's assets"
(cd "$download_dir" && sha256sum --check --strict SHA256SUMS >/dev/null) ||
  fail "published payload checksum verification failed"

receipt="$download_dir/RELEASE-RECEIPT.txt"
grep -Fxq "fork_release=$tag" "$receipt" || fail "receipt tag does not match"
grep -Fxq "source_sha=$source_sha" "$receipt" || fail "receipt source SHA does not match"
receipt_digests="$(sed -n 's/^github_asset_digests=//p' "$receipt")"
[[ -n "$receipt_digests" ]] || fail "receipt has no GitHub asset digests"
recorded_checksums="$(sed -n '/^artifact_sha256:$/,$p' "$receipt" | tail -n +2)"
cmp -s <(printf '%s\n' "$recorded_checksums") "$download_dir/SHA256SUMS" ||
  fail "receipt checksum block does not match the downloaded payload"
jq -e --argjson receipt "$receipt_digests" \
  '([.[] | select(.name != "RELEASE-RECEIPT.txt") | {name, digest}] | sort_by(.name)) == ($receipt | sort_by(.name))' \
  <<<"$assets_json" >/dev/null || fail "receipt GitHub digests do not match the release assets"

while IFS=$'\t' read -r name digest; do
  [[ -n "$name" && -n "$digest" ]] || continue
  actual="sha256:$(sha256sum "$download_dir/$name" | cut -d ' ' -f 1)"
  [[ "$actual" == "$digest" ]] || fail "GitHub digest mismatch for $name"
done < <(jq -r '.[] | [.name, .digest] | @tsv' <<<"$assets_json")

echo "Published release $tag exactly matches source $source_sha and this run's payload."
