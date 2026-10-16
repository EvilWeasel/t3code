import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  EventId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  WsRpcGroup,
  WS_METHODS,
  type AuthEnvironmentScope,
  type OrchestrationV2AppThread,
  type MainRendererDiagnosticsReadInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { layerMainRendererDiagnosticsWs } from "../server.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AgentObservatory from "../observatory/AgentObservatoryService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as CodexLiveSessionService from "../voice/CodexLiveSessionService.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Keybindings from "../keybindings.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "../diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as RemoteOpenTargets from "../environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProvisioningService from "../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";

// A: genuine registered /ws + real isolated auth/session store + the SAME production
// alias/default native inspector. No positive packaged-Main claim: this hosted
// process deliberately has no canonical Nix Main/profile/listener for this stateDir.
const environmentId = EnvironmentId.make("24efa85c-862c-4de4-9b5e-aaaa041e28a4");
const threadId = ThreadId.make("7cd05d6b-5e09-4691-a664-0b56c6283f12");
const target: MainRendererDiagnosticsReadInput["target"] = {
  environmentId: "24efa85c-862c-4de4-9b5e-aaaa041e28a4",
  threadId: "7cd05d6b-5e09-4691-a664-0b56c6283f12",
  providerInstanceId: "codex",
};
type DiagnosticsRpc = Extract<
  RpcGroup.Rpcs<typeof WsRpcGroup>,
  { readonly _tag: typeof WS_METHODS.serverGetTraceDiagnostics }
>;
const selectorGroup = RpcGroup.make(
  ...[...WsRpcGroup.requests.values()].filter(
    (rpc): rpc is DiagnosticsRpc => rpc._tag === WS_METHODS.serverGetTraceDiagnostics,
  ),
);

const makeRegisteredFixture = (
  fd: boolean,
  servingEnvironmentId: EnvironmentId = environmentId,
  threadExists = true,
) =>
  Effect.gen(function* () {
    const configLayer = ServerConfig.layerTest("/fixture", { prefix: "registered-main-diag-" });
    const platform = Layer.mergeAll(NodeServices.layer, NodeHttpServer.layerTest);
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(configLayer),
      Effect.provide(NodeServices.layer),
    );
    const isolatedConfig = Layer.succeed(ServerConfig.ServerConfig, {
      ...config,
      desktopTelemetryFd: undefined,
      desktopTelemetryControlFd: fd ? 8 : undefined,
    });
    const identity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(servingEnvironmentId),
    });
    const database = SqlitePersistence.layerMemory;
    const secretStore = ServerSecretStore.layer.pipe(Layer.provide(isolatedConfig));
    const auth = EnvironmentAuth.layer.pipe(
      Layer.provideMerge(database),
      Layer.provide(secretStore),
      Layer.provide(identity),
      Layer.provide(isolatedConfig),
    );
    const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
      Effect.provide(ProjectionStore.layerMemory),
    );
    const now = yield* DateTime.now;
    const providerInstanceId = ProviderInstanceId.make("codex");
    const thread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("project:diagnostics"),
      title: "Isolated admission fixture",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "fixture" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
    };
    if (threadExists)
      yield* projections.apply({
        id: EventId.make("event:diagnostics:thread"),
        type: "thread.created",
        threadId,
        providerInstanceId,
        occurredAt: now,
        payload: thread,
      });
    let selectorReads = 0;
    const getThreadRecords: ThreadManagementService.ThreadManagementServiceShape["getThreadRecords"] =
      (id, fields, filter) => {
        return Effect.suspend(() => {
          selectorReads += 1;
          return projections
            .getThreadRecords(id, fields, filter)
            .pipe(
              Effect.mapError(
                (cause) => new Orchestrator.OrchestratorProjectionError({ threadId: id, cause }),
              ),
            );
        });
      };
    const unrelated = Layer.mergeAll(
      Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
      Layer.mock(ProjectStore.ProjectStoreV2)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(CodexLiveSessionService.CodexLiveSessionService)({}),
      Layer.mock(AgentObservatory.AgentObservatoryService)({}),
      Layer.mock(ThreadSearch.ThreadSearch)({}),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
      Layer.mock(McpAppRequests.McpAppRequests)({}),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(PullRequestService.PullRequestService)({}),
      Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
      Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
      Layer.mock(DeviceService.DeviceService)({}),
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(UsageService.UsageService)({}),
      Layer.mock(UsageLimitSources.UsageLimitSources)({}),
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
      Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
      Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
      Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
      Layer.mock(Keybindings.Keybindings)({}),
      Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
      Layer.mock(DirectEndpoints.DirectEndpoints)({}),
      Layer.mock(GitWorkflowService.GitWorkflowService)({}),
      Layer.mock(ReviewService.ReviewService)({}),
      Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
      Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
      Layer.mock(TerminalManager.TerminalManager)({}),
      Layer.mock(PreviewManager.PreviewManager)({}),
      Layer.mock(PortScanner.PortDiscovery)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(ModelManifest.ModelManifest)({}),
      Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
      Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
      Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
      Layer.mock(ProviderAuthService.ProviderAuthService)({}),
      Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
      Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
      Layer.mock(StorageCleanup.StorageCleanup)({}),
      Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
      Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
      Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
      Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
      Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
      Layer.mock(HostResources.HostResources)({}),
      Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
      Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
      Layer.mock(RelayClient.RelayClient)({}),
      Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({}),
      Layer.mock(ServerBrowser.ServerBrowser)({}),
      Layer.mock(CodexInstallation.CodexInstallation)({
        managedDirectory: `${config.baseDir}/tools/codex`,
      }),
      Layer.mock(AntigravityInstallation.AntigravityInstallation)({
        managedDirectory: `${config.baseDir}/tools/antigravity`,
      }),
      Layer.mock(VcsProcess.VcsProcess)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({ getThreadRecords }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: config.baseDir,
      }),
      Layer.mock(AnalyticsService.AnalyticsService)({ record: () => Effect.void }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(servingEnvironmentId),
      }),
    );
    const settings = ServerSettings.layerTest();
    // The hosted fixture owns no desktop bootstrap descriptor. Use the EXISTING
    // receiver IO seam to refuse startup settings writes, never write an invented
    // descriptor in the test runner. Diagnostic readiness still runs the actual
    // receiver (no negotiated peer), not an injected diagnostic result/handler.
    const receiver = Layer.effect(
      DesktopTelemetryReceiver.DesktopTelemetryReceiver,
      DesktopTelemetryReceiver.make({
        write: (descriptor) =>
          Effect.fail(
            new DesktopTelemetryReceiver.DesktopTelemetryControlFailed({
              fd: descriptor,
              operation: "fixture-no-parent",
              cause: "No owned parent descriptor",
            }),
          ),
      }),
    ).pipe(Layer.provide(isolatedConfig), Layer.provide(settings));
    const services = yield* Layer.build(
      Layer.mergeAll(
        unrelated,
        auth,
        identity,
        isolatedConfig,
        secretStore,
        settings,
        receiver,
        Layer.succeed(HostProcess.HomeDirectory, config.baseDir),
        Layer.succeed(HostProcess.Environment, {}),
      ).pipe(Layer.provideMerge(platform)),
    );
    // Production alias is imported directly, never rebuilt with an injected inspector
    // or replaced registered handler. All unrelated methods remain fail-closed mocks.
    yield* Layer.build(
      HttpRouter.serve(layerMainRendererDiagnosticsWs, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(Layer.succeedContext(services))),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    const authService = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const invoke = (
      scopes: ReadonlyArray<AuthEnvironmentScope>,
      request: MainRendererDiagnosticsReadInput,
    ) =>
      Effect.gen(function* () {
        const session = yield* authService.issueSession({
          scopes,
          label: "isolated registered diagnostics",
        });
        const ticket = yield* authService.issueWebSocketTicket(session);
        const url = new URL("/ws", HttpServer.formatAddress(server.address));
        url.protocol = "ws:";
        url.searchParams.set(
          ORCHESTRATION_PROTOCOL_QUERY_PARAM,
          ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        );
        url.searchParams.set("wsTicket", ticket.ticket);
        const client = yield* RpcClient.make(selectorGroup).pipe(
          Effect.provide(
            RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
              Layer.provide(RpcSerialization.layerJson),
              Layer.provide(
                Socket.layerWebSocket(url.toString()).pipe(
                  Layer.provide(Socket.layerWebSocketConstructorGlobal),
                ),
              ),
            ),
          ),
        );
        return yield* client[WS_METHODS.serverGetTraceDiagnostics]({
          mainRendererSnapshot: request,
        });
      });
    const request: MainRendererDiagnosticsReadInput = {
      requestId: "registered-read",
      requestNonce: "synthetic-nonce",
      target,
      optIn: true,
      expiresAtMs: DateTime.toEpochMillis(yield* DateTime.now) + 5000,
    };
    return { invoke, request, selectorReads: () => selectorReads };
  });

it.live.each([false, true])(
  "A: actual registered dual-scope gate and production %s topology without manufactured native ownership",
  (fd) =>
    Effect.gen(function* () {
      const f = yield* makeRegisteredFixture(fd);
      const deniedScopes: ReadonlyArray<ReadonlyArray<AuthEnvironmentScope>> = [
        [AuthDiagnosticsReadScope],
        [AuthOrchestrationReadScope],
      ];
      for (const scopes of deniedScopes) {
        const error = yield* f.invoke(scopes, f.request).pipe(Effect.flip);
        assert.equal(error._tag, "EnvironmentAuthorizationError");
        assert.equal(f.selectorReads(), 0);
      }
      const result = yield* f.invoke(
        [AuthDiagnosticsReadScope, AuthOrchestrationReadScope],
        f.request,
      );
      assert.deepEqual(
        result.mainRendererSnapshot,
        fd
          ? {
              status: "unavailable",
              reason: "unsupported",
              unsupportedDiagnostic: {
                site: "fd-peer-missing",
                route: "fd",
                handlerAvailable: true,
              },
            }
          : { status: "unavailable", reason: "not-main" },
      );
      assert.equal(f.selectorReads(), 1);
      // C: genuine packaged Main positive is intentionally OPEN, not synthesized here.
    }),
);

const targetMismatchCases: ReadonlyArray<"environment" | "missing-thread"> = [
  "environment",
  "missing-thread",
];
it.live.each(targetMismatchCases)(
  "A: registered serving target refuses %s before default native admission",
  (mismatch) =>
    Effect.gen(function* () {
      const f = yield* makeRegisteredFixture(
        false,
        mismatch === "environment"
          ? EnvironmentId.make("isolated-other-environment")
          : environmentId,
        mismatch !== "missing-thread",
      );
      const result = yield* f.invoke(
        [AuthDiagnosticsReadScope, AuthOrchestrationReadScope],
        f.request,
      );
      assert.deepEqual(result.mainRendererSnapshot, {
        status: "unavailable",
        reason: "target-mismatch",
      });
      assert.equal(f.selectorReads(), mismatch === "environment" ? 0 : 1);
    }),
);
