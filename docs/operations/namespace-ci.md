# Namespace CI

Set `WEASEL_LINUX_RUNNER` to the exact runner-profile label provisioned in
Namespace after the GitHub App is installed for `morrowbyte/t3code`. The existing
CI and Linux release stages use this variable. Windows continues to use its
existing runner because this migration targets the Linux/shared-bundle work.

Enable a cache volume on the profile and protect cache writes to trusted branches.
The workflow restores pnpm dependencies before installing them. GitHub-hosted
fallback runs retain setup-vp caching. `Weasel CI` can be manually dispatched for
runner acceptance without publishing a release.

Reference: https://namespace.so/docs/solutions/github-actions

The x86-64 Linux runner labels in all workflows, including reusable desktop
build callers, are now `namespace-profile-ci-builder`. ARM, macOS and Windows
retain their architecture-specific runners. Blacksmith-only apt mirror rewriting
is conditional. Validation: git diff --check and actionlint comparison against the unmodified
baseline. Four preexisting actionlint findings remain identical (discussion
events, concurrency queue and run_started_at context); no new findings. Runner execution is
separate from source migration.

The fork Windows release now selects `nscloud-windows-2022-amd64-8x16` directly,
which avoids requiring a second dashboard profile. Remaining Blacksmith Windows,
macOS and Linux ARM labels also select the corresponding documented Namespace
machine shapes. Windows ARM remains on its existing GitHub runner because the
Namespace machine-label reference lists Windows AMD64 only. First packaging runs
are the compatibility evidence; runner-label configuration alone is not acceptance.
