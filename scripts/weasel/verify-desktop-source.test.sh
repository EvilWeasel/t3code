#!/usr/bin/env bash
set -euo pipefail

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
guard="$script_root/verify-desktop-source.sh"
fixture_parent="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
fixture="$(mktemp -d "$fixture_parent/weasel-desktop-source-test.XXXXXX")"
fixture="$(cd -- "$fixture" && pwd -P)"
case "$fixture" in
  "$fixture_parent"/weasel-desktop-source-test.*) ;;
  *) echo 'Unexpected fixture path.' >&2; exit 1 ;;
esac
trap 'rm -rf -- "$fixture"' EXIT

git init --bare --quiet "$fixture/origin.git"
git init --quiet --initial-branch=main "$fixture/work"
cd -- "$fixture/work"
git config user.name 'CI source guard fixture'
git config user.email 'ci-source-guard@example.invalid'
git config commit.gpgsign false
git config core.autocrlf false
git remote add origin "$fixture/origin.git"
printf 'main\n' > fixture.txt
git add fixture.txt
git commit --quiet -m main
main_sha="$(git rev-parse HEAD)"
git push --quiet origin main
git switch --quiet -c fix/native-livevoice-fixture
printf 'candidate\n' >> fixture.txt
git commit --quiet -am candidate
candidate_sha="$(git rev-parse HEAD)"
git push --quiet origin HEAD
git tag fixture-tag "$candidate_sha"
git push --quiet origin fixture-tag

checks=0
accept() {
  if ! bash "$guard" "$@" > "$fixture/check.log" 2>&1; then
    echo 'Expected source guard acceptance.' >&2
    cat "$fixture/check.log" >&2
    exit 1
  fi
  checks=$((checks + 1))
}
reject() {
  if bash "$guard" "$@" > "$fixture/check.log" 2>&1; then
    echo 'Expected source guard rejection.' >&2
    exit 1
  fi
  checks=$((checks + 1))
}

accept "$candidate_sha" false refs/heads/fix/native-livevoice-fixture "$candidate_sha"
reject "$candidate_sha" true refs/heads/fix/native-livevoice-fixture "$candidate_sha"
reject "$candidate_sha" false refs/heads/fix/native-livevoice-fixture "$main_sha"
reject "$candidate_sha" false refs/heads/main "$candidate_sha"
reject "$candidate_sha" false refs/tags/fixture-tag "$candidate_sha"
reject "$candidate_sha" false refs/heads/missing-fixture "$candidate_sha"
reject "$candidate_sha" false 'refs/heads/bad..ref' "$candidate_sha"
reject "$candidate_sha" '' refs/heads/fix/native-livevoice-fixture "$candidate_sha"
reject invalid false refs/heads/fix/native-livevoice-fixture "$candidate_sha"

# Moving the remote branch after dispatch must fail, even if local HEAD is unchanged.
printf 'advanced\n' >> fixture.txt
git commit --quiet -am advanced
advanced_sha="$(git rev-parse HEAD)"
git push --quiet origin HEAD
git checkout --quiet --detach "$candidate_sha"
reject "$candidate_sha" false refs/heads/fix/native-livevoice-fixture "$candidate_sha"
reject "$advanced_sha" false refs/heads/fix/native-livevoice-fixture "$advanced_sha"

git checkout --quiet --detach "$main_sha"
accept "$main_sha" true refs/heads/main "$main_sha"
accept "$main_sha" false refs/heads/main "$main_sha"

# Publishing an older main revision remains rejected after main advances.
git push --quiet origin "$advanced_sha:refs/heads/main"
reject "$main_sha" true refs/heads/main "$main_sha"
git checkout --quiet --detach "$advanced_sha"
accept "$advanced_sha" true refs/heads/main "$advanced_sha"

printf 'Desktop source guard: %s checks passed.\n' "$checks"
