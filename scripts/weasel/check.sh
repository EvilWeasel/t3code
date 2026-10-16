#!/usr/bin/env bash
set -euo pipefail

bash scripts/weasel/test.sh
python3 packaging/nixos/test-updater.py

vp_cmd() {
  if command -v vp >/dev/null 2>&1; then
    vp "$@"
  else
    corepack pnpm exec vp "$@"
  fi
}

# Route generation is hosted evidence, not a committed source edit.
if [[ -f apps/web/src/routes/observatory.tsx ]]; then
  test "${GITHUB_ACTIONS:-}" = true
  test -n "${RUNNER_TEMP:-}"
  timeout 90s node --input-type=module <<'OBSERVATORY_ROUTE_GENERATION'
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const root = process.cwd();
const generated = 'apps/web/src/routeTree.gen.ts';
const directory = join(process.env.RUNNER_TEMP, 'observatory-route-generation');
mkdirSync(directory, { recursive: false, mode: 0o700 });
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 4 * 1024 * 1024 }).toString();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const receipt = { status: 'incomplete', source: git('rev-parse', 'HEAD').trim(), run: process.env.GITHUB_RUN_ID,
  effectiveSourceSha: process.env.EFFECTIVE_SOURCE_SHA, trustedContextSha: process.env.GITHUB_SHA,
  trustedWorkflowSha: process.env.GITHUB_WORKFLOW_SHA, trustedWorkflowRef: process.env.GITHUB_WORKFLOW_REF,
  attempt: process.env.GITHUB_RUN_ATTEMPT, lockSha256: sha(readFileSync('pnpm-lock.yaml')),
  beforeSha256: sha(readFileSync(generated)), command: 'Generator({config:getConfig({autoCodeSplitting:true},appsWebRoot),root:appsWebRoot}).run()',
  config: { autoCodeSplitting: true }, generatorVersion: null, afterSha256: null,
  checkScriptSha256: sha(readFileSync('scripts/weasel/check.sh')) };
const persist = () => writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
persist();
try {
  if (git('status', '--porcelain', '--untracked-files=all').trim()) throw Error('checkout-not-clean');
  if (!/^[0-9a-f]{40}$/.test(receipt.effectiveSourceSha ?? '') || receipt.source !== receipt.effectiveSourceSha) throw Error('source-mismatch');
  const require = createRequire(resolve('apps/web/package.json'));
  const pluginRequire = createRequire(require.resolve('@tanstack/router-plugin/vite'));
  receipt.generatorResolvedPath = pluginRequire.resolve('@tanstack/router-generator');
  receipt.generatorVersion = pluginRequire('@tanstack/router-generator/package.json').version;
  if (receipt.generatorVersion !== '1.167.12') throw Error('generator-version-mismatch');
  persist();
  const { Generator, getConfig } = pluginRequire('@tanstack/router-generator');
  const web = resolve('apps/web');
  await new Generator({ config: getConfig({ autoCodeSplitting: true }, web), root: web }).run();
  const changes = git('diff', '--name-only', 'HEAD').trim().split('\n').filter(Boolean);
  if (changes.length !== 1 || changes[0] !== generated) throw Error('unexpected-tracked-delta');
  if (git('ls-files', '--others', '--exclude-standard').trim()) throw Error('unexpected-untracked-file');
  if (git('rev-parse', 'HEAD').trim() !== receipt.source || sha(readFileSync('pnpm-lock.yaml')) !== receipt.lockSha256) throw Error('source-changed');
  const bytes = readFileSync(generated);
  if (bytes.length > 1024 * 1024 || !bytes.toString().includes('/observatory')) throw Error('generated-route-missing-or-oversized');
  receipt.afterSha256 = sha(bytes);
  const diff = git('diff', '--binary', 'HEAD', '--', generated);
  if (Buffer.byteLength(diff) > 2 * 1024 * 1024) throw Error('generated-diff-oversized');
  copyFileSync(generated, join(directory, 'routeTree.gen.ts'));
  writeFileSync(join(directory, 'routeTree.diff'), diff, { mode: 0o600 });
  receipt.status = 'generated-unreviewed';
} finally { persist(); }
OBSERVATORY_ROUTE_GENERATION
fi

typecheck_failed=0
for package in \
  @t3tools/contracts \
  @t3tools/client-runtime \
  @t3tools/provider-core \
  t3 \
  @t3tools/web \
  @t3tools/desktop \
  @t3tools/mobile; do
  if ! vp_cmd run --filter="$package" typecheck; then
    typecheck_failed=1
  fi
done

if ! vp_cmd run --filter=@t3tools/scripts typecheck; then
  typecheck_failed=1
fi
if [[ "$typecheck_failed" != 0 ]]; then
  exit 1
fi
focused_tests=(
  packages/contracts/src/server.test.ts \
  packages/contracts/src/environmentHttp.test.ts \
  packages/client-runtime/src/state/serverConfigProjection.test.ts \
  packages/client-runtime/src/rpc/session.test.ts \
  apps/desktop/src/app/DesktopEarlyElectronStartup.test.ts \
  apps/desktop/src/app/DesktopEnvironment.test.ts \
  apps/desktop/src/app/DesktopWindowsProfileBinding.test.ts \
  apps/desktop/src/app/DesktopAppIdentity.test.ts \
  apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts \
  apps/desktop/src/backend/DesktopBackendConfiguration.test.ts \
  apps/desktop/src/wsl/DesktopWslBackend.test.ts
  apps/desktop/src/updates/DesktopUpdates.test.ts
  apps/desktop/src/updates/DesktopRemoteUpdates.test.ts
  apps/desktop/src/updates/updateChannels.test.ts
  apps/desktop/src/updates/remoteUpdateFlow.test.ts
  apps/desktop/src/updates/updateMachine.test.ts
  apps/desktop/src/electron/ElectronUpdater.test.ts
  apps/desktop/src/electron/NixManagedUpdater.test.ts
  apps/desktop/src/electron/quitAndInstallInPlace.test.ts
  apps/web/src/components/sidebar/updateEverything.logic.test.ts
  apps/web/src/components/ProviderUpdateLaunchNotification.logic.test.ts
  apps/web/src/components/ServerUpdateAction.test.tsx
  apps/web/src/components/desktopUpdate.logic.test.ts
  apps/web/src/branding.test.ts
  apps/web/src/connection/fleetBootstrap.test.ts
  apps/web/src/components/FleetConnectionBootstrap.test.tsx
  apps/server/src/auth/fleet.test.ts
  apps/server/src/auth/http.test.ts
  packages/shared/src/cliRelease.test.ts
  packages/provider-core/src/server/maintenanceResolver.test.ts
  apps/server/src/cli/update.test.ts
  apps/server/src/cloud/selfUpdate.test.ts
  apps/server/src/environment/ServerEnvironment.test.ts
  apps/server/src/cloud/pinnedRuntime.test.ts
  apps/server/src/serviceLauncher.test.ts
  apps/server/src/serverRuntimeState.test.ts
  apps/server/src/voice/VoiceSettings.test.ts
  apps/web/src/voice/VoiceDictationControl.test.tsx
  apps/web/src/voice/LiveVoiceControl.test.tsx
  apps/web/src/voice/LiveVoiceCommands.test.ts
  apps/web/src/components/settings/VoiceTranscriptionSettings.test.tsx
  apps/web/src/voice/voiceSettingsClient.test.ts
)
observatory_tests=(
  apps/web/src/observatory/AgentObservatory.test.tsx
  packages/client-runtime/src/observatory/authored.test.ts
  packages/client-runtime/src/observatory/bridge.test.ts
  packages/client-runtime/src/observatory/state.test.ts
  packages/contracts/src/agentObservatory.test.ts
  packages/client-runtime/src/observatory/paging.test.ts
  apps/server/src/observatory/AgentObservatoryService.test.ts
  apps/server/src/orchestration-v2/ProjectionStore.test.ts
  packages/contracts/src/orchestrationV2.test.ts
  apps/server/src/mcp/TrustedAppControlInvocation.test.ts
  packages/contracts/src/clientRpcPermissions.test.ts
)
for observatory_test in "${observatory_tests[@]}"; do
  if [[ ! -f "$observatory_test" ]]; then
    echo "Required agent observatory gate is missing: $observatory_test" >&2
    exit 1
  fi
  focused_tests+=("$observatory_test")
done
main_renderer_diagnostics_tests=(
  apps/desktop/src/app/DesktopApp.test.ts
  apps/desktop/src/app/DesktopAppActivation.test.ts
  apps/server/src/diagnostics/MainRendererDiagnosticsLocalClient.test.ts
  apps/server/src/ws.test.ts
  apps/desktop/src/ipc/DesktopIpc.test.ts
  packages/contracts/src/rpc.test.ts
  apps/desktop/src/ipc/methods/mainRendererDiagnostics.test.ts
  apps/desktop/src/telemetry/DesktopTelemetryPublisher.test.ts
  apps/server/src/resourceTelemetry/DesktopTelemetryReceiver.test.ts
  apps/server/src/auth/RpcAuthorization.test.ts
  packages/client-runtime/src/state/server.test.ts
)
for diagnostic_test in "${main_renderer_diagnostics_tests[@]}"; do
  if [[ ! -f "$diagnostic_test" ]]; then
    echo "Required Main renderer diagnostic gate is missing: $diagnostic_test" >&2
    exit 1
  fi
  focused_tests+=("$diagnostic_test")
done
server_continuation_tests=(
  apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts
  apps/server/src/orchestration-v2/FoundationPersistence.test.ts
  apps/server/src/orchestration-v2/ProjectionRecovery.test.ts
  apps/server/src/orchestration-v2/ProviderSessionManager.test.ts
  apps/server/src/orchestration-v2/RestartContinuation.test.ts
  apps/server/src/orchestration-v2/ThreadManagementService.test.ts
  apps/server/src/orchestration-v2/runtimeLayer.test.ts
  apps/server/src/process/agentScope.test.ts
  apps/server/src/mcp/OrchestratorMcpService.activity.test.ts
  apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts
)
for server_continuation_test in "${server_continuation_tests[@]}"; do
  if [[ ! -f "$server_continuation_test" ]]; then
    echo "Required server continuation gate is missing: $server_continuation_test" >&2
    exit 1
  fi
  focused_tests+=("$server_continuation_test")
done
automatic_update_tests=(
  apps/desktop/src/backend/DesktopBackendManager.test.ts
  apps/desktop/src/backend/DesktopBackendPool.test.ts
  apps/desktop/src/ipc/methods/updates.test.ts
  apps/web/src/state/desktopUpdate.test.ts
  apps/web/src/state/desktopUpdateReadiness.test.ts
  apps/web/src/state/desktopUpdateDraftPersistence.test.ts
  apps/web/src/composerDraftStore.test.ts
)
for automatic_update_test in "${automatic_update_tests[@]}"; do
  if [[ ! -f "$automatic_update_test" ]]; then
    echo "Required update readiness gate is missing: $automatic_update_test" >&2
    exit 1
  fi
  focused_tests+=("$automatic_update_test")
done
approval_tests=(
  apps/web/src/components/chat/ComposerPendingApprovalPanel.test.tsx
  apps/web/src/components/chat/ComposerPendingApprovalActions.test.tsx
  apps/web/src/components/chat/ApprovalActionSummary.test.tsx
  apps/mobile/src/features/threads/PendingApprovalCard.test.tsx
)
for approval_test in "${approval_tests[@]}"; do
  if [[ ! -f "$approval_test" ]]; then
    echo "Required approval gate is missing: $approval_test" >&2
    exit 1
  fi
  focused_tests+=("$approval_test")
done
execution_tests=(
  apps/web/src/reopenClosedView.test.ts
  apps/web/src/closedViewStore.test.ts
  apps/web/src/rightPanelStore.test.ts
  apps/web/src/components/RightPanelTabs.test.tsx
  apps/web/src/lib/executionCode.test.ts
  apps/web/src/components/chat/ExecutionCodePanel.test.tsx
)
for execution_test in "${execution_tests[@]}"; do
  if [[ ! -f "$execution_test" ]]; then
    echo "Required execution code gate is missing: $execution_test" >&2
    exit 1
  fi
  focused_tests+=("$execution_test")
done
native_integration_tests=(
  packages/contracts/src/orchestratorMcp.test.ts
  packages/contracts/src/jarvis.test.ts
  apps/server/src/mcp/OrchestratorMcpService.test.ts
  apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts
  apps/server/src/integrations/jarvis/JarvisClient.test.ts
  apps/server/src/integrations/jarvis/JarvisService.test.ts
)
for native_integration_test in "${native_integration_tests[@]}"; do
  if [[ ! -f "$native_integration_test" ]]; then
    echo "Required native integration gate is missing: $native_integration_test" >&2
    exit 1
  fi
  focused_tests+=("$native_integration_test")
done
voice_tests=(
  apps/web/src/voice/recordingDraftStore.test.ts
  apps/web/src/voice/useVoiceDictation.test.tsx
  packages/client-runtime/src/state/voiceTranscriptionHttp.test.ts
)
for voice_test in "${voice_tests[@]}"; do
  if [[ "$voice_test" == apps/web/src/voice/recordingDraftStore.test.ts && ! -f "$voice_test" ]]; then
    echo "Required recording durability gate is missing: $voice_test" >&2
    exit 1
  fi
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
if [[ ! -f "$transcript_ui_test" ]]; then
  echo "Required Transcript UI gate is missing: $transcript_ui_test" >&2
  exit 1
fi
focused_tests+=("$transcript_ui_test")
echo "Including required Transcript UI gate: $transcript_ui_test"
agent_session_tests=(
  packages/contracts/src/agentSessions.test.ts
  apps/server/src/project/AgentSessionScanner.test.ts
  apps/server/src/project/AgentSessionImporter.test.ts
)
for agent_session_test in "${agent_session_tests[@]}"; do
  if [[ ! -f "$agent_session_test" ]]; then
    echo "Required agent session gate is missing: $agent_session_test" >&2
    exit 1
  fi
  focused_tests+=("$agent_session_test")
done
vp_cmd test run --config vite.config.ts "${focused_tests[@]}"
(cd scripts && vp_cmd test run --config ../vite.config.ts build-desktop-artifact.test.ts lib/morrowbyte-branding.test.ts)
