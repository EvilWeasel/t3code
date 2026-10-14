# NixOS packaging for T3 Code (Weasel Nightly)

The flake packages the released AppImage as a native Nix application. It extracts
and patches its bundled ELF executables, supplies GTK/accessibility/audio/graphics
libraries, and builds the package **only on the Namespace release runner**.
Destination machines never evaluate this flake or compile a package during updates.

The release publishes `T3-Code-<version>-x86_64-linux-nix-closure.nar.zst` and a
matching `.json` manifest. The manifest binds the version, system, root Store path,
archive name and SHA-256. The installer verifies both assets against their GitHub
release digests, imports the complete prebuilt closure, checks Store contents and
registers a GC root. An import denied by local Nix permissions fails; there is no
local-build or unsigned-download fallback. Keep the pinned nixpkgs revision aligned
with the host configuration when intentionally changing the package runtime.

## Install and update

On x86_64 Linux with Nix, curl, jq, zstd and standard shell utilities available:

```bash
bash packaging/nixos/install.sh --update
```

This chooses the newest fork-owned release on the selected channel and atomically
switches `~/.local/share/t3code-weasel/current`. Existing processes keep running.
An existing launcher is preserved because it may supply a private credential wrapper
or an explicit `T3CODE_HOME`. New standalone installs get a user-local launcher.
`T3_WEASEL_DATA_DIR` controls the version/GC-root directory independently of the
application's `T3CODE_HOME`; changing versions never migrates a profile.

Other operations:

```bash
bash packaging/nixos/install.sh --check
bash packaging/nixos/install.sh --prepare <version>
bash packaging/nixos/install.sh --activate <version>
bash packaging/nixos/install.sh --rollback <installed-version>
```

`--check` only reads release metadata and verifies its manifest; it does not change
installation state. `--prepare` imports and roots the exact version without switching
`current`. `--activate` only selects a prepared version, without network access.
`--rollback` selects a retained version. Previous versions remain rooted; none are
automatically deleted. Concurrent installation/activation is serialized.

`T3_WEASEL_CHANNEL=stable` requires fork-owned `Weasel Stable` releases and never
falls back to nightly. Nightly is the default. `T3_WEASEL_MANAGED=1` suppresses new
user launcher creation when configuration management owns that launcher.

## Desktop update button

Native Nix packages use the same local and remote desktop update flow as other
packages. The managed adapter prepares the verified closure during download, then
activates it during install. It restarts through the stable user launcher, retaining
its inherited profile and environment. `T3CODE_NIX_LAUNCHER` can explicitly name that
launcher; otherwise the existing Linux protocol launcher or
`~/.local/bin/t3code-weasel` is used. The launcher must resolve `current`, not a fixed
old Store path. `T3CODE_DISABLE_AUTO_UPDATE=true` remains an explicit opt-out.

Windows continues to use Electron/NSIS and ordinary Linux AppImages use their
existing updater. The managed Nix adapter never overwrites an immutable Store file.
A successful import or restart dispatch is not remote acceptance: the caller still
checks reconnection, environment identity and advertised version.
