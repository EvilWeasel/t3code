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
  @t3tools/provider-core \
  t3 \
  @t3tools/web \
  @t3tools/desktop; do
  vp_cmd run --filter="$package" typecheck
done

vp_cmd run --filter=@t3tools/scripts typecheck
focused_tests=(
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
live_tests=(
  packages/client-runtime/src/live-voice/controller.test.ts
  packages/client-runtime/src/state/commandPermissions.test.ts
  packages/contracts/src/liveVoice.test.ts
  packages/provider-core/src/server/codexRealtimeAdoption.test.ts
  packages/provider-core/src/server/codexRealtimeLease.test.ts
  apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts
  apps/server/src/orchestration-v2/RunExecutionService.test.ts
  apps/server/src/persistence/Migrations.test.ts
  apps/server/src/persistence/Migrations/063_CodexLiveVoice.test.ts
  apps/server/src/voice/CodexLiveEventHub.test.ts
  apps/server/src/voice/CodexLiveSessionService.test.ts
  apps/server/src/observability/RpcInstrumentation.test.ts
)
for live_test in "${live_tests[@]}"; do
  if [[ ! -f "$live_test" ]]; then
    echo "Required Live voice gate is missing: $live_test" >&2
    exit 1
  fi
  focused_tests+=("$live_test")
done
pair_test=apps/server/src/cli/pair.test.ts
if [[ ! -f "$pair_test" ]]; then
  echo "Required pairing gate is missing: $pair_test" >&2
  exit 1
fi
focused_tests+=("$pair_test")
echo "Including required pairing gate: $pair_test"

connection_tests=(
  packages/client-runtime/src/relay/discovery.test.ts
  packages/client-runtime/src/connection/registry.test.ts
)
for connection_test in "${connection_tests[@]}"; do
  if [[ ! -f "$connection_test" ]]; then
    echo "Required connection gate is missing: $connection_test" >&2
    exit 1
  fi
  focused_tests+=("$connection_test")
  echo "Including required connection gate: $connection_test"
done
connection_layer_test=packages/client-runtime/src/connection/layer.test.ts
if [[ -f "$connection_layer_test" ]]; then
  focused_tests+=("$connection_layer_test")
  echo "Including connection layer gate: $connection_layer_test"
else
  echo "Connection layer gate not present in this source; NOT EXECUTED: $connection_layer_test"
fi

transcript_ui_test=apps/web/src/voice/LiveVoiceTranscript.test.tsx
if [[ -f "$transcript_ui_test" ]]; then
  focused_tests+=("$transcript_ui_test")
  echo "Including Transcript UI gate: $transcript_ui_test"
elif [[ -f apps/web/src/voice/LiveVoiceTranscript.tsx ]]; then
  echo "Required Transcript UI gate is missing: $transcript_ui_test" >&2
  exit 1
else
  echo "Transcript UI gate not present in this source; NOT EXECUTED: $transcript_ui_test"
fi
vp_cmd test run --config vite.config.ts "${focused_tests[@]}"
(cd scripts && vp_cmd test run --config ../vite.config.ts build-desktop-artifact.test.ts)
