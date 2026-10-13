#!/usr/bin/env bash
set -euo pipefail

upstream_repo="pingdotgg/t3code"
fork_branch="main"
issue_title="Weasel upstream nightly merge conflict"
issue_body_file="$(mktemp)"
trap 'rm -f "$issue_body_file"' EXIT

releases_json="$(gh api "repos/$upstream_repo/releases" --paginate --slurp)"
nightly_tag="$(jq -r '[.[][] | select(.draft == false and .published_at != null and (.tag_name | test("^(v.*-nightly\\.|nightly-v)")))] | sort_by(.published_at) | last | .tag_name // empty' <<<"$releases_json")"
if [[ -z "$nightly_tag" ]]; then
  echo "No published upstream nightly release was found." >&2
  exit 1
fi

git fetch upstream "$nightly_tag" --no-tags
nightly_sha="$(git rev-parse FETCH_HEAD)"
git fetch origin "$fork_branch"
git switch --detach FETCH_HEAD
base_sha="$(git rev-parse HEAD)"

if git merge-base --is-ancestor "$nightly_sha" "$base_sha"; then
  echo "Upstream nightly $nightly_tag is already contained in origin/$fork_branch."
  exit 0
fi

if ! git merge --no-edit "$nightly_sha"; then
  git merge --abort || true
  open_issue="$(gh issue list --state open --search "\"$issue_title\" in:title" --json number --jq '.[0].number // empty')"
  issue_marker="<!-- weasel-upstream-conflict:$nightly_tag -->"
  issue_update="$issue_marker

Nightly **$nightly_tag** ($nightly_sha) could not be cleanly merged into fork main at $base_sha. The public branch was not changed."
  if [[ -n "$open_issue" ]]; then
    issue_text="$(gh issue view "$open_issue" --json body,comments --jq '[.body, (.comments[] | .body)] | join("\\n")')"
    if ! grep -Fq "$issue_marker" <<<"$issue_text"; then
      gh issue comment "$open_issue" --body "$issue_update"
    fi
    echo "Conflict is tracked by existing issue #$open_issue."
  else
    printf '%s\n\n%s\n' "$issue_update" 'Resolve the conflict in a repair change, then rerun the sync workflow.' > "$issue_body_file"
    gh issue create --title "$issue_title" --body-file "$issue_body_file"
  fi
  exit 0
fi

vp install --frozen-lockfile
bash scripts/weasel/check.sh

# Fetch once more and allow only a normal fast-forward push. If another writer
# advanced main during validation, leave it untouched for the next sync run.
git fetch origin "$fork_branch"
latest_main="$(git rev-parse FETCH_HEAD)"
if ! git merge-base --is-ancestor "$latest_main" HEAD; then
  echo "Fork main advanced during validation; no push was attempted." >&2
  exit 1
fi
git push origin "HEAD:refs/heads/$fork_branch"

# Actions started by GITHUB_TOKEN do not chain from pushes. Dispatch the gated
# asset build explicitly and pin it to the commit just promoted.
gh workflow run weasel-release.yml --ref "$fork_branch" -f source_sha="$(git rev-parse HEAD)"
