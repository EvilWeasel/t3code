#!/usr/bin/env bash
set -euo pipefail

test "$#" -eq 4
source_sha="$1"
publish="$2"
dispatched_ref="$3"
dispatched_sha="$4"

[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]
test "$(git rev-parse HEAD)" = "$source_sha"

case "$publish" in
  true)
    git fetch origin main
    git merge-base --is-ancestor "$source_sha" FETCH_HEAD
    test "$(git rev-parse FETCH_HEAD)" = "$source_sha"
    ;;
  false)
    # Unpublished artifacts must come from the exact dispatched branch revision.
    [[ "$dispatched_ref" == refs/heads/* ]]
    git check-ref-format "$dispatched_ref"
    test "$source_sha" = "$dispatched_sha"
    git fetch --no-tags origin "$dispatched_ref"
    test "$(git rev-parse FETCH_HEAD)" = "$source_sha"
    ;;
  *)
    echo 'Publish mode must be exactly true or false.' >&2
    exit 1
    ;;
esac
