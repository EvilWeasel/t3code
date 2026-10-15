# CI runners

The owner migrated `morrowbyte/t3code` to Blacksmith on 2026-10-15 after account verification and billing setup. This supersedes the earlier Namespace-only build policy for this repository. Compilation and full suites remain remote; there is no laptop or Hephaestus fallback.

`WEASEL_LINUX_RUNNER=blacksmith-8vcpu-ubuntu-2404` and `WEASEL_WINDOWS_RUNNER=blacksmith-8vcpu-windows-2025` control the fork CI and desktop release. Workflow defaults use the same labels. Linux ARM uses `blacksmith-16vcpu-ubuntu-2404-arm`; macOS uses the 6- or 12-vCPU macOS 26 runners. Existing larger Windows jobs retain 32 vCPUs.

The native Windows ARM64 release lane retains `windows-11-arm`: Blacksmith currently documents Windows x64 only. That lane runs ARM64 PowerShell and builds and smoke-tests native ARM64 CLI executables. Replacing its runner with x64 would not preserve this behavior. This is the only GitHub-hosted platform exception.

Namespace cache-volume actions were removed. Vite+ and upstream Actions caches use Blacksmith's transparent Actions cache service. The synthetic Electron probe uses provider-neutral `MORROWBYTE_CI_PROBE` / `MORROWBYTE_CI_PROFILE` while retaining its CI-only, synthetic-profile guard.

Run `Weasel CI` manually to build an unpublished product bundle. `Weasel desktop nightly` accepts `publish=false` to exercise Linux, NixOS and Windows packaging without changing the release feed; normal release callers retain publishing by default. A runner acceptance workflow in `morrowbyte/.github` covers Linux x64/ARM64, Windows x64 and macOS. Dispatch, successful source checks, packaged artifacts and installed behavior are distinct evidence.

Runner and cache reference: https://docs.blacksmith.sh/blacksmith-runners/overview and https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions.
