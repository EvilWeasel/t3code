#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
cat > "$fixture/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == release ]]; then
  jq -n --arg url "${FIXTURE_API_URL:-https://api.github.com/repos/fixture/t3code/releases/123}" \
    --arg sha "${FIXTURE_SHA:-qualified}" --argjson draft "${FIXTURE_DRAFT:-true}" \
    '{apiUrl:$url,isDraft:$draft,targetCommitish:$sha,tagName:"vtest"}'
elif [[ "$1" == api && "$2" == https://api.github.com/repos/fixture/t3code/releases/123 ]]; then
  printf '%s\n' '{"draft":true,"tag_name":"vtest","target_commitish":"qualified","assets":[{"name":"app","digest":"sha256:abc"},{"name":"RELEASE-RECEIPT.txt","digest":"sha256:receipt"}]}'
else
  echo '404: draft tag endpoint unavailable' >&2
  exit 1
fi
EOF
chmod +x "$fixture/gh"
export PATH="$fixture:$PATH" GH_REPO=fixture/t3code
actual="$(bash "$repo_root/scripts/weasel/read-draft-release-assets.sh" vtest qualified)"
jq -e 'length == 1 and .[0].name == "app"' <<<"$actual" >/dev/null
for scenario in wrong_source published foreign_repository; do
  unset FIXTURE_SHA FIXTURE_DRAFT FIXTURE_API_URL
  case "$scenario" in
    wrong_source) export FIXTURE_SHA=unqualified ;;
    published) export FIXTURE_DRAFT=false ;;
    foreign_repository) export FIXTURE_API_URL=https://api.github.com/repos/other/t3code/releases/123 ;;
  esac
  if bash "$repo_root/scripts/weasel/read-draft-release-assets.sh" vtest qualified >/dev/null 2>&1; then
    echo "Draft verification incorrectly accepted $scenario" >&2
    exit 1
  fi
done
