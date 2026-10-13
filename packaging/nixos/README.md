# NixOS packaging for T3 Code (Weasel Nightly)

This package installs the public Linux AppImage published by
[`morrowbyte/t3code`](https://github.com/morrowbyte/t3code/releases), extracts
it, patches its bundled ELF executables with `autoPatchelfHook`, and supplies
the native GTK, accessibility, PulseAudio/ALSA, and graphics runtime libraries.
It does not use an AppImage or FHS runtime launcher: those can set `NoNewPrivs`
on the desktop process and prevent approved `sudo` commands in child coding
agents.

The flake pins the same nixpkgs revision as the read-only
`/home/evilweasel/weasel-os/flake.lock`. Keep that revision aligned with the
root flake lock; this directory intentionally has no independent lockfile.
The installer passes release data to the impure flake evaluation only after
validating the public GitHub release SHA-256. Nix verifies the same hash while
fetching the package input. This prepares and patches a prebuilt binary; it
does not compile T3 Code or its Electron application.

## User install and update

On x86_64 NixOS with `nix`, `curl`, `jq`, and `sha256sum` available, run from
this checkout:

```bash
bash packaging/nixos/install.sh
```

For a standalone install from the laptop, the operator command is:

```bash
curl --fail --silent --show-error --location https://raw.githubusercontent.com/morrowbyte/t3code/main/packaging/nixos/install.sh | bash
```

That command downloads the installer and its Nix expression from the fork's
`main` branch. To pin a packaging revision, set
`T3_WEASEL_PACKAGING_REF=<commit-or-tag>` before running it.

The command reads only the latest release of `morrowbyte/t3code` and requires
its versioned `T3-Code-<version>-x86_64.AppImage` asset and GitHub SHA-256
digest. It selects only prereleases with the standard
`v<major>.<minor>.<patch>-nightly.<date>.<run>` tag and a release name starting
with `Weasel Nightly`, then orders matches by GitHub publication time. The
fixed `morrowbyte/t3code` repository plus this release-name marker exclude
pre-fork releases while keeping the standard channel shape expected by the
desktop updater.
It creates a user-local launcher at `~/.local/bin/t3code-weasel`, a
visible `T3 Code (Weasel Nightly)` desktop entry, and versioned package links
below `~/.local/share/t3code-weasel/versions`. Each version link is a Nix build
output link and keeps that version rooted against garbage collection. After a successful download,
hash check, and Nix package build, it atomically changes `current`; the previous
version stays available for rollback. It does not set MIME defaults, modify a
system profile, replace official T3/MT, restart running processes, or migrate
live data. Updating the pointer does not alter an already-running process.

To switch back to an installed version, atomically repoint `current`:

```bash
ln -sfn "$HOME/.local/share/t3code-weasel/versions/<version>" \
  "$HOME/.local/share/t3code-weasel/current.next"
mv -Tf "$HOME/.local/share/t3code-weasel/current.next" \
  "$HOME/.local/share/t3code-weasel/current"
```

The runtime uses the fork's release-provided `com.evilweasel.t3code` identity
and `T3CODE_HOME=~/.local/share/t3code-weasel` so it remains separate from
official T3 and MT user data. Upstream self-update is disabled; run the
installer again to select and verify the next fork release. There is no Windows
package here.

## Automatic updates

weasel-os installs a pinned copy of this updater and package recipe, a stable
launcher and a systemd user timer. It selects the nightly channel by default.
`--update` validates the GitHub asset digest, builds an immutable Nix package,
roots it, then atomically switches `current`. Concurrent updates are serialized.
Existing processes, live data, official T3 and MT remain untouched.

`--check` reports the newest qualified release without changing installation
state; `--status` reports local state without network access. `--rollback VERSION`
selects an already installed Nix version. Previous packages remain rooted; this
updater does not automatically delete versions. `T3_WEASEL_MANAGED=1` suppresses
mutable desktop/launcher writes when Home Manager owns those files.

The `stable` channel requires fork-owned `Weasel Stable` releases; it never falls
back to nightly. Release packaging currently publishes nightly only. Windows
continues to use the existing Electron/NSIS update feed from the same repository,
and ordinary Linux uses its AppImage updater. The NixOS updater is separate
because store packages are immutable. This mechanism prepares a new version for
the next launch; it does not force a desktop/server restart.
