#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

fixture_repo="$test_root/repo"
fixture_remote="$test_root/origin.git"
fixture_assets="$test_root/assets"
fixture_api="$test_root/release.json"
fake_bin="$test_root/bin"
tag="v0.0.47-nightly.20261013.1"
version="0.0.47-nightly.20261013.1"
mkdir -p "$fixture_repo" "$fixture_assets" "$fake_bin"
git init --bare "$fixture_remote" >/dev/null
git -C "$fixture_repo" init -b main >/dev/null
git -C "$fixture_repo" config user.name fixture
git -C "$fixture_repo" config user.email fixture@example.invalid
git -C "$fixture_repo" commit --allow-empty -m fixture >/dev/null
source_sha="$(git -C "$fixture_repo" rev-parse HEAD)"
git -C "$fixture_repo" -c tag.gpgSign=false tag "$tag" "$source_sha"
git -C "$fixture_repo" remote add origin "$fixture_remote"
git -C "$fixture_repo" push origin main "refs/tags/$tag" >/dev/null

for asset in \
  nightly-linux.yml \
  nightly.yml \
  weasel-linux-x64.tar.gz \
  "T3-Code-$version-x86_64.AppImage" \
  install-linux.sh \
  "t3-$version-linux-x64.tar.gz" \
  "t3-$version-win32-x64.zip"; do
  printf 'fixture payload: %s\n' "$asset" > "$fixture_assets/$asset"
done
(cd "$fixture_assets" && sha256sum ./* > SHA256SUMS)

payload_digests='[]'
for file in "$fixture_assets"/*; do
  name="$(basename "$file")"
  digest="sha256:$(sha256sum "$file" | cut -d ' ' -f 1)"
  payload_digests="$(jq -c --arg name "$name" --arg digest "$digest" '. + [{name: $name, digest: $digest}]' <<<"$payload_digests")"
done
{
  printf 'fork_release=%s\nsource_sha=%s\npnpm_lock_sha256=fixture\n' "$tag" "$source_sha"
  printf 'github_asset_digests=%s\n' "$(jq -c 'sort_by(.name)' <<<"$payload_digests")"
  printf 'artifact_sha256:\n'
  cat "$fixture_assets/SHA256SUMS"
} > "$fixture_assets/RELEASE-RECEIPT.txt"

all_asset_digests="$payload_digests"
receipt_digest="sha256:$(sha256sum "$fixture_assets/RELEASE-RECEIPT.txt" | cut -d ' ' -f 1)"
all_asset_digests="$(jq -c --arg digest "$receipt_digest" '. + [{name: "RELEASE-RECEIPT.txt", digest: $digest}]' <<<"$all_asset_digests")"
jq -n --arg tag "$tag" --argjson assets "$all_asset_digests" \
  '{tag_name: $tag, draft: false, prerelease: true, assets: $assets}' > "$fixture_api"

cat > "$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "api" ]]; then
  cat "$WEASEL_FIXTURE_API"
elif [[ "$1" == "release" && "$2" == "download" ]]; then
  destination=""
  while (($#)); do
    if [[ "$1" == "--dir" ]]; then
      destination="$2"
      shift 2
    else
      shift
    fi
  done
  cp "$WEASEL_FIXTURE_ASSETS"/* "$destination/"
else
  echo "unexpected gh invocation: $*" >&2
  exit 2
fi
EOF
chmod +x "$fake_bin/gh"

export PATH="$fake_bin:$PATH"
export WEASEL_FIXTURE_API="$fixture_api"
export WEASEL_FIXTURE_ASSETS="$fixture_assets"
export WEASEL_VERIFY_GIT_REMOTE=origin
export GH_REPO=fixture/t3code

cd "$fixture_repo"
bash "$repo_root/scripts/weasel/verify-published-release.sh" \
  "$tag" "$source_sha" "$version" "$fixture_assets" >/dev/null

if bash "$repo_root/scripts/weasel/verify-published-release.sh" \
  "$tag" "0000000000000000000000000000000000000000" "$version" "$fixture_assets" >/dev/null 2>&1; then
  echo "Verifier accepted a tag pointing at the wrong source SHA." >&2
  exit 1
fi

cp "$fixture_api" "$test_root/release.good.json"
jq '(.assets[] | select(.name == "nightly.yml").digest) = "sha256:wrong"' \
  "$fixture_api" > "$test_root/release.bad-digest.json"
mv "$test_root/release.bad-digest.json" "$fixture_api"
if bash "$repo_root/scripts/weasel/verify-published-release.sh" \
  "$tag" "$source_sha" "$version" "$fixture_assets" >/dev/null 2>&1; then
  echo "Verifier accepted a mismatched GitHub asset digest." >&2
  exit 1
fi
mv "$test_root/release.good.json" "$fixture_api"

printf 'changed payload\n' >> "$fixture_assets/nightly-linux.yml"
if bash "$repo_root/scripts/weasel/verify-published-release.sh" \
  "$tag" "$source_sha" "$version" "$fixture_assets" >/dev/null 2>&1; then
  echo "Verifier accepted an asset set that differs from the published release." >&2
  exit 1
fi
