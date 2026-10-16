// @effect-diagnostics nodeBuiltinImport:off -- The fixture uses real owned Unix sockets and replaces only native Electron/process identity boundaries.
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as Events from "node:events";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  WsRpcGroup,
  WS_METHODS,
  type MainRendererDiagnosticsRequest,
  type MainRendererDiagnosticsUnsupportedSite,
  type MainRendererDiagnosticsResponse,
} from "@t3tools/contracts";
import type * as Electron from "electron";
import * as ServerConfig from "../config.ts";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import { readMainRendererDiagnosticsForTarget } from "../ws.ts";
import { make, inspectLocalMainBinding } from "./MainRendererDiagnosticsLocalClient.ts";
import { startDesktopAppControlServer } from "../../../desktop/src/app/DesktopAppControlServer.ts";
import * as MainDiagnostics from "../../../desktop/src/ipc/methods/mainRendererDiagnostics.ts";
import * as ElectronWindow from "../../../desktop/src/electron/ElectronWindow.ts";
import * as ElectronApp from "../../../desktop/src/electron/ElectronApp.ts";

const target = {
  environmentId: "24efa85c-862c-4de4-9b5e-aaaa041e28a4",
  threadId: "7cd05d6b-5e09-4691-a664-0b56c6283f12",
  providerInstanceId: "codex",
} as const;
const version = "0.0.47-nightly.20261015.29";
const sender = { sender: { id: 70 }, senderFrame: { processId: 11, routingId: 12, parent: null } };
function response(binding: MainRendererDiagnosticsRequest): MainRendererDiagnosticsResponse {
  return {
    binding,
    rendererEpoch: 1,
    revision: 1,
    result: {
      status: "ready",
      gate: {
        ...target,
        phase: "idle",
        targetPresent: true,
        active: false,
        busy: false,
        webRtcAvailable: true,
        microphoneApiAvailable: true,
        canStart: false,
        reason: "Waiting for this environment's provider settings.",
        facts: null,
        prepareFailure: null,
      },
    },
  };
}

it.live.each([
  "ready",
  "profile-replaced",
  "navigation",
  "source-close",
  "subframe",
  "fd-busy",
] as const)(
  "real local socket and actual Main service share admission and refuse %s boundaries",
  (boundary) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "main-diag-local-"))),
          (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
        );
        const userId = yield* HostProcess.UserId;
        const config = yield* ServerConfig.ServerConfig;
        const stateDir = NodePath.join(root, "userdata");
        const address = resolveDesktopAppControlAddress({
          stateDir,
          platform: "linux",
          tempDir: NodeOS.tmpdir(),
          userId,
          joinPath: NodePath.join,
        });
        if (userId === undefined || address.directory === null) return;
        const requested = yield* Deferred.make<MainRendererDiagnosticsRequest>();
        const release = yield* Deferred.make<void>();
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        let activates = 0;
        let sends = 0;
        let replaced = false;
        let current = true;
        let service: MainDiagnostics.MainRendererDiagnostics["Service"];
        const wc = Object.assign(new Events.EventEmitter(), {
          id: 70,
          isDestroyed: () => false,
          mainFrame: { processId: 11, routingId: 12 },
          send: (_channel: string, request: MainRendererDiagnosticsRequest) => {
            sends++;
            void run(
              Effect.gen(function* () {
                yield* Deferred.succeed(requested, request);
                yield* Deferred.await(release);
                const accepted = yield* service.respond(
                  response(request),
                  boundary === "subframe"
                    ? { ...sender, senderFrame: { ...sender.senderFrame, parent: {} } }
                    : sender,
                );
                if (boundary === "subframe") {
                  assert.equal(accepted, false);
                  wc.emit("did-start-navigation", {}, "", false, true);
                }
              }),
            );
          },
        });
        const window = {
          id: 7,
          webContents: wc,
          isDestroyed: () => false,
        } as unknown as Electron.BrowserWindow;
        service = yield* MainDiagnostics.make().pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.mock(ElectronWindow.ElectronWindow)({
                main: Effect.sync(() => (current ? Option.some(window) : Option.none())),
              }),
              Layer.mock(ElectronApp.ElectronApp)({
                metadata: Effect.succeed({
                  appVersion: version,
                  appPath: root,
                  isPackaged: true,
                  resourcesPath: root,
                  runningUnderArm64Translation: false,
                }),
              }),
            ),
          ),
        );
        const server = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startDesktopAppControlServer({
              ...address,
              userId,
              handle: async (r) => {
                activates++;
                return {
                  version: 1,
                  requestId: r.requestId,
                  ok: false,
                  code: "internal-error",
                  message: "not activation",
                };
              },
              cancel: () => {
                activates++;
              },
              onReclaimError: () => undefined,
              diagnostics: {
                mainPid: process.pid,
                stateDir,
                appVersion: version,
                read: (source, alive, input) => run(service.read(source, alive, input)),
                cancel: (source) => {
                  void run(service.cancelSource(source));
                },
              },
            }),
          ),
          (s) => Effect.promise(() => s.close()),
        );
        const client = yield* make({
          inspect: async () => ({
            mainPid: process.pid,
            version,
            socketInode: replaced ? 2 : 1,
            listenerInode: "fixture-native-owner",
          }),
        }).pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            ...config,
            stateDir,
            desktopTelemetryFd: undefined,
            desktopTelemetryControlFd: undefined,
          }),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        const request = {
          requestId: "read-1",
          requestNonce: "nonce-1",
          optIn: true as const,
          expiresAtMs: DateTime.toEpochMillis(yield* DateTime.now) + 5_000,
          target,
        };
        const group = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (
              tag,
            ): tag is Exclude<
              keyof typeof RPC_REQUIRED_SCOPES,
              typeof WS_METHODS.serverGetTraceDiagnostics
            > => tag !== WS_METHODS.serverGetTraceDiagnostics,
          ),
        );
        const rpc = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverGetTraceDiagnostics, (input) => {
                const requested = input.mainRendererSnapshot;
                if (!requested) return Effect.die("Fixture only invokes the explicit selector");
                return readMainRendererDiagnosticsForTarget(
                  requested,
                  target.environmentId,
                  Effect.succeed(true),
                  client.read(requested, target.environmentId),
                ).pipe(Effect.map((mainRendererSnapshot) => ({ mainRendererSnapshot })));
              }),
              RpcAuthorization.layer([AuthDiagnosticsReadScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        const fdRead =
          boundary === "fd-busy"
            ? yield* service
                .read("held-fd-attempt", () => true, { ...request, requestId: "first-fd" })
                .pipe(Effect.forkScoped)
            : undefined;
        if (fdRead) yield* Deferred.await(requested);
        const reading = yield* rpc[WS_METHODS.serverGetTraceDiagnostics]({
          mainRendererSnapshot: request,
        }).pipe(
          Effect.map((value) => {
            if (!("mainRendererSnapshot" in value))
              throw new Error("Expected explicit diagnostic response");
            return value.mainRendererSnapshot;
          }),
          Effect.forkScoped,
        );
        yield* Deferred.await(requested);
        const concurrent = yield* service.read("other-fd-attempt", () => true, {
          ...request,
          requestId: "other",
        });
        assert.deepEqual(concurrent, { status: "unavailable", reason: "busy" });
        if (boundary === "profile-replaced") replaced = true;
        if (boundary === "navigation") wc.emit("did-start-navigation", {}, "", false, true);
        if (boundary === "source-close") {
          current = false;
          yield* Effect.promise(() => server.close());
        }
        if (!fdRead) yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(reading);
        if (fdRead) {
          assert.deepEqual(result, { status: "unavailable", reason: "busy" });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(fdRead);
        }
        if (boundary === "ready") {
          assert.equal(result.status, "ready");
          if (result.status === "ready") {
            assert.equal(result.appVersion, version);
            assert.equal(result.response.binding.requestId, request.requestId);
          }
        } else assert.equal(result.status, "unavailable");
        assert.equal(sends, 1);
        assert.equal(activates, 0);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerConfig.layerTest("/fixture", { prefix: "local-main" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
);

it.live(
  "native binding refuses an actual unrelated process even with owned socket and matching profile PID",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "main-owner-"))),
          (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
        );
        const userId = yield* HostProcess.UserId;
        if (userId === undefined) return;
        const address = NodePath.join(root, "control.sock");
        const lock = NodePath.join(root, "SingletonLock");
        yield* Effect.promise(() => NodeFS.symlink(`${NodeOS.hostname()}-${process.pid}`, lock));
        yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeNet.Server>((resolve, reject) => {
                const server = NodeNet.createServer();
                server.once("error", reject);
                server.listen(address, () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        yield* Effect.promise(() => NodeFS.chmod(address, 0o600));
        const inspect = () =>
          Effect.tryPromise({
            try: () =>
              inspectLocalMainBinding({ address, directory: root, profileLockPath: lock, userId }),
            catch: (error) => (error instanceof Error ? error.message : "unexpected"),
          }).pipe(Effect.flip);
        assert.equal(yield* inspect(), "local-main-executable-unavailable");
        yield* Effect.promise(() => NodeFS.chmod(root, 0o755));
        assert.equal(yield* inspect(), "local-main-ownership-unavailable");
      }),
    ),
);

it.live(
  "strict raw input, expiry and foreign serving environment are refused before native inspection",
  () =>
    Effect.gen(function* () {
      let inspected = 0;
      const client = yield* make({
        inspect: async () => {
          inspected++;
          throw new Error("must not inspect");
        },
      });
      const input = {
        requestId: "read",
        requestNonce: "nonce",
        target,
        optIn: true as const,
        expiresAtMs: DateTime.toEpochMillis(yield* DateTime.now) + 5_000,
      };
      const malformed = { ...input, rawSettings: "refused" };
      assert.deepEqual(yield* client.read(malformed, target.environmentId), {
        status: "unavailable",
        reason: "invalid-response",
      });
      assert.deepEqual(yield* client.read(input, "foreign"), {
        status: "unavailable",
        reason: "target-mismatch",
      });
      assert.deepEqual(yield* client.read({ ...input, expiresAtMs: 0 }, target.environmentId), {
        status: "unavailable",
        reason: "expired",
      });
      assert.equal(inspected, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerConfig.layerTest("/fixture", { prefix: "local-main-refusal" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
);

const unsupportedPreflightCases: ReadonlyArray<{
  platform: NodeJS.Platform;
  userId: number | undefined;
  fd: boolean;
  site: MainRendererDiagnosticsUnsupportedSite;
}> = [
  { platform: "win32", userId: undefined, fd: true, site: "local-platform" },
  { platform: "linux", userId: undefined, fd: true, site: "local-user-id" },
  { platform: "linux", userId: 1000, fd: true, site: "local-fd-conflict" },
];
it.effect.each(unsupportedPreflightCases)(
  "attributes the original local preflight guard $site before inspection",
  (scenario) =>
    Effect.gen(function* () {
      let inspections = 0;
      const config = yield* ServerConfig.ServerConfig;
      const client = yield* make({
        inspect: async () => {
          inspections += 1;
          throw new Error("Unexpected native inspection after preflight refusal");
        },
      }).pipe(
        Effect.provideService(HostProcess.Platform, scenario.platform),
        Effect.provideService(HostProcess.UserId, scenario.userId),
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          desktopTelemetryFd: scenario.fd ? 7 : undefined,
          desktopTelemetryControlFd: undefined,
        }),
      );
      const result = yield* client.read(
        {
          requestId: "preflight",
          requestNonce: "nonce",
          target,
          optIn: true,
          expiresAtMs: DateTime.toEpochMillis(yield* DateTime.now) + 5000,
        },
        target.environmentId,
      );
      assert.deepEqual(result, {
        status: "unavailable",
        reason: "unsupported",
        unsupportedDiagnostic: { site: scenario.site },
      });
      assert.equal(inspections, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerConfig.layerTest("/fixture", { prefix: "unsupported-preflight-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
);
