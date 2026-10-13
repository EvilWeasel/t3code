# Namespace CI

Set `WEASEL_LINUX_RUNNER` to the exact runner-profile label provisioned in
Namespace after the GitHub App is installed for `morrowbite/t3code`. The existing
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
is conditional. Validation: actionlint and git diff --check. Runner execution is
separate from source migration.
