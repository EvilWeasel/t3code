#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
directory="$(mktemp -d)"
trap 'rm -rf -- "$directory"' EXIT
version=0.0.47-nightly.20261014.16
asset="T3-Code-$version-x86_64-linux-nix-closure.nar.zst"
manifest="$directory/${asset%.nar.zst}.json"
printf 'fixture closure\n' > "$directory/$asset"
digest="$(sha256sum "$directory/$asset" | cut -d ' ' -f 1)"
jq -n --arg version "$version" --arg asset "$asset" --arg digest "$digest" \
  '{schemaVersion:1,version:$version,system:"x86_64-linux",compression:"zstd",asset:$asset,sha256:$digest,storePath:"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-t3code-weasel"}' > "$manifest"
verify() { bash "$root/scripts/weasel/verify-nixos-closure.sh" "$version" "$directory"; }
verify
cp "$manifest" "$directory/valid.json"
for patch in '.version = "wrong"' '.asset = "../closure"' '.storePath = "/tmp/closure"' '.system = "aarch64-linux"' '.compression = "none"'; do
  jq "$patch" "$directory/valid.json" > "$manifest"
  if verify; then echo "Accepted invalid closure metadata: $patch" >&2; exit 1; fi
done
cp "$directory/valid.json" "$manifest"
printf 'corruption\n' >> "$directory/$asset"
if verify; then echo 'Accepted corrupt closure' >&2; exit 1; fi
