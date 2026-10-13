#!/usr/bin/env bash
set -euo pipefail

bash scripts/weasel/test.sh

vp_cmd() {
  if command -v vp >/dev/null 2>&1; then
    vp "$@"
  else
    corepack pnpm exec vp "$@"
  fi
}

for package in \
  @t3tools/contracts \
  @t3tools/client-runtime \
  t3 \
  @t3tools/web \
  @t3tools/desktop; do
  vp_cmd run --filter="$package" typecheck
done

vp_cmd run --filter=@t3tools/scripts typecheck
focused_tests=(
  apps/server/src/mcp/PreviewAutomationBroker.test.ts
  apps/server/src/mcp/toolkits/html/tools.test.ts
  apps/server/src/htmlRender/HtmlRender.test.ts
  apps/desktop/src/app/DesktopEarlyElectronStartup.test.ts \
  apps/desktop/src/app/DesktopEnvironment.test.ts \
  apps/desktop/src/app/DesktopAppIdentity.test.ts \
  apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts \
  apps/desktop/src/backend/DesktopBackendConfiguration.test.ts \
  apps/desktop/src/wsl/DesktopWslBackend.test.ts
)
voice_tests=(
  apps/web/src/voice/useVoiceDictation.test.tsx
  packages/client-runtime/src/state/voiceTranscriptionHttp.test.ts
)
for voice_test in "${voice_tests[@]}"; do
  if [[ -f "$voice_test" ]]; then
    focused_tests+=("$voice_test")
  elif [[ "${WEASEL_ALLOW_MISSING_VOICE_TESTS:-0}" == "1" ]]; then
    echo "NOT QUALIFIED: explicitly skipping missing $voice_test for local pre-integration checks." >&2
  else
    echo "Required voice gate is missing: $voice_test" >&2
    exit 1
  fi
done
server_voice_test=apps/server/src/voice/VoiceTranscriptionService.test.ts
if [[ ! -f "$server_voice_test" ]]; then
  echo "Required server voice gate is missing: $server_voice_test" >&2
  exit 1
fi
focused_tests+=("$server_voice_test")
server_http_test=apps/server/src/voice/http.test.ts
if [[ ! -f "$server_http_test" ]]; then
  echo "Required server voice HTTP gate is missing: $server_http_test" >&2
  exit 1
fi
focused_tests+=("$server_http_test")
vp_cmd test run --config vite.config.ts "${focused_tests[@]}"
(cd scripts && vp_cmd test run --config ../vite.config.ts build-desktop-artifact.test.ts)
