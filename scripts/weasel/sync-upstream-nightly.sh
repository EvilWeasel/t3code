#!/usr/bin/env bash
set -euo pipefail

upstream_repo="pingdotgg/t3code"
fork_branch="main"
issue_title="Weasel upstream nightly merge conflict"
issue_body_file="$(mktemp)"
trap 'rm -f "$issue_body_file"' EXIT

reconcile_release_dispatch() {
  local source_sha="$1"
  local run_name="Weasel desktop release $source_sha"
  local runs_json matching_runs active_run successful_run finished_run

  runs_json="$(gh run list \
    --workflow weasel-release.yml \
    --branch "$fork_branch" \
    --limit 1000 \
    --json databaseId,displayTitle,status,conclusion,event)"
  matching_runs="$(jq -c --arg run_name "$run_name" \
    '[.[] | select(.event == "workflow_dispatch" and .displayTitle == $run_name)]' \
    <<<"$runs_json")"
  active_run="$(jq -r '[.[] | select(.status != "completed")][0].databaseId // empty' <<<"$matching_runs")"
  successful_run="$(jq -r '[.[] | select(.status == "completed" and .conclusion == "success")][0].databaseId // empty' <<<"$matching_runs")"
  finished_run="$(jq -r '[.[] | select(.status == "completed")][0] | if . == null then empty else "\(.databaseId):\(.conclusion)" end' <<<"$matching_runs")"

  if [[ -n "$active_run" ]]; then
    echo "Release run #$active_run is already active for $source_sha; not dispatching another."
    return 0
  fi
  if [[ -n "$successful_run" ]]; then
    echo "Release run #$successful_run already succeeded for $source_sha."
    return 0
  fi
  if [[ -n "$finished_run" ]]; then
    echo "Release run $finished_run already exists for $source_sha; inspect or rerun it manually instead of dispatching a duplicate." >&2
    return 1
  fi

  echo "No active or successful release run exists for $source_sha; dispatching the missing release."
  gh workflow run weasel-release.yml --ref "$fork_branch" -f source_sha="$source_sha"
}

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

# Sync commits are authored by the Actions bot. This identity is local to the
# ephemeral runner and does not depend on, or copy, a human signing key.
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if git merge-base --is-ancestor "$nightly_sha" "$base_sha"; then
  echo "Upstream nightly $nightly_tag is already contained in origin/$fork_branch."
  reconcile_release_dispatch "$base_sha"
  exit 0
fi

if git merge --no-edit "$nightly_sha"; then
  :
else
  merge_status=$?
  unmerged_paths="$(git diff --name-only --diff-filter=U)"
  if [[ -z "$unmerged_paths" ]]; then
    echo "git merge failed with exit $merge_status and no unmerged paths; not classifying this as a conflict." >&2
    git status --short >&2
    exit "$merge_status"
  fi

  printf 'Conflicting paths:\n%s\n' "$unmerged_paths" >&2
  git merge --abort
  open_issue="$(gh issue list --state open --search "\"$issue_title\" in:title" --json number --jq '.[0].number // empty')"
  issue_metadata="$(jq -cn \
    --arg tag "$nightly_tag" \
    --arg base_sha "$base_sha" \
    --arg nightly_sha "$nightly_sha" \
    '{tag: $tag, base_sha: $base_sha, nightly_sha: $nightly_sha, repair_agent_status: "not_scheduled"}')"
  issue_marker="<!-- weasel-upstream-conflict:$issue_metadata -->"
  issue_update="$issue_marker

Nightly **$nightly_tag** ($nightly_sha) could not be cleanly merged into fork main at $base_sha. The public branch was not changed.

Repair agent status: **not scheduled**. The fork pipeline does not activate or dispatch a repair agent; durable host scheduling and integration are owned by the parent."
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
reconcile_release_dispatch "$(git rev-parse HEAD)"
