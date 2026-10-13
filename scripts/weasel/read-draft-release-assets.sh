#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 ]] || { echo 'Usage: read-draft-release-assets.sh <tag> <source-sha>' >&2; exit 2; }
tag="$1"
source_sha="$2"
repo="${GH_REPO:-EvilWeasel/t3code}"
release="$(gh release view "$tag" --repo "$repo" --json apiUrl,isDraft,targetCommitish,tagName)"
jq -e --arg tag "$tag" --arg source "$source_sha" \
  '.isDraft == true and .tagName == $tag and .targetCommitish == $source' \
  <<<"$release" >/dev/null || { echo 'Draft release identity does not match the qualified build.' >&2; exit 1; }
api_url="$(jq -er '.apiUrl' <<<"$release")"
prefix="https://api.github.com/repos/$repo/releases/"
[[ "$api_url" == "$prefix"* && "${api_url#"$prefix"}" =~ ^[0-9]+$ ]] || \
  { echo 'Draft release API URL is outside the canonical repository.' >&2; exit 1; }
# A draft has no published tag endpoint yet. Resolve it by immutable release ID.
metadata="$(gh api "$api_url")"
jq -e --arg tag "$tag" --arg source "$source_sha" \
  '.draft == true and .tag_name == $tag and .target_commitish == $source' \
  <<<"$metadata" >/dev/null || { echo 'Draft release changed before asset verification.' >&2; exit 1; }
jq -c '[.assets[] | select(.name != "RELEASE-RECEIPT.txt") | {name, digest}]' <<<"$metadata"
