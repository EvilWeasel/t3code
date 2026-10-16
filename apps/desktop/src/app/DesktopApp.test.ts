import { assert, describe, it } from "@effect/vitest";
import type { DesktopServerExposureState } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import { bootstrap } from "./DesktopApp.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopState from "./DesktopState.ts";

type Event =
  | "protocol"
  | "ipc"
  | "legacy-storage"
  | "snapshot"
  | "control-start"
  | "control-release"
  | "exposure-configure"
  | "backend-start"
  | "window";

const makeFixture = (input: {
  readonly localEnvironmentEnabled: boolean;
  readonly quitting?: boolean;
  readonly controlFailure?: boolean;
}) =>
  Effect.gen(function* () {
    const events: Event[] = [];
    const record = (event: Event) => Effect.sync(() => void events.push(event));
    const state = {
      quitting: yield* Ref.make(input.quitting ?? false),
      backendReady: yield* Ref.make(false),
    };
    const settings = {
      ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
      localEnvironmentEnabled: input.localEnvironmentEnabled,
    };
    const primary: DesktopBackendPool.DesktopBackendInstance = {
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: Effect.succeed("Fixture primary"),
      start: record("backend-start"),
      stop: () => Effect.die("Unexpected fixture backend stop"),
      currentConfig: Effect.succeedNone,
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 0,
        restartScheduled: false,
      }),
      waitForReady: () => Effect.die("Unexpected fixture readiness wait"),
    };
    const startControl = input.controlFailure
      ? record("control-start").pipe(
          Effect.andThen(
            Effect.fail(
              new DesktopAppActivation.DesktopAppActivationStartError({
                address: "fixture-control-address",
                cause: "fixture control start refusal",
              }),
            ),
          ),
        )
      : Effect.acquireRelease(record("control-start"), () => record("control-release"));
    const exposureState: DesktopServerExposureState = {
      mode: "local-only",
      endpointUrl: null,
      advertisedHost: null,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    };
    const services = Layer.mergeAll(
      Layer.succeed(DesktopState.DesktopState, state),
      DesktopAppSettings.layerTest(settings),
      Layer.mock(DesktopEnvironment.DesktopEnvironment)({
        isDevelopment: false,
        configuredBackendPort: Option.some(3_773),
        clientAssetsDir: "/fixture/client",
        defaultDesktopSettings: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
      }),
      Layer.mock(ElectronProtocol.ElectronProtocol)({
        registerDesktopProtocol: () => record("protocol"),
      }),
      Layer.mock(DesktopAppIdentity.DesktopAppIdentity)({
        resolveUserDataPath: Effect.succeed("/fixture/profile"),
      }),
      Layer.mock(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage)({
        load: () => record("legacy-storage"),
      }),
      Layer.mock(DesktopSnapShot.DesktopSnapShot)({ initialize: record("snapshot") }),
      Layer.mock(DesktopAppActivation.DesktopAppActivation)({ start: startControl }),
      Layer.mock(DesktopWindow.DesktopWindow)({
        createMainIfBackendReady: record("window"),
      }),
      Layer.mock(DesktopBackendPool.DesktopBackendPool)({ primary: Effect.succeed(primary) }),
      Layer.mock(DesktopServerExposure.DesktopServerExposure)({
        configureFromSettings: () => record("exposure-configure").pipe(Effect.as(exposureState)),
        backendConfig: Effect.succeed({
          port: 3_773,
          bindHost: "127.0.0.1",
          httpBaseUrl: new URL("http://127.0.0.1:3773"),
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        }),
      }),
      Layer.mock(DesktopWslBackend.DesktopWslBackend)({ reconcile: Effect.void }),
      Layer.mock(NetService.NetService)({
        canListenOnHost: () => Effect.die("Unexpected fixture port scan"),
      }),
    );
    // Only the IPC installation boundary is supplied. This is the same bootstrap
    // used by production, not a replay of its branch or startup decisions.
    const run = bootstrap(record("ipc")).pipe(Effect.provide(services));
    return { events, run };
  });

describe("desktop bootstrap control listener", () => {
  it.effect("starts control after IPC/storage/snapshot with the local environment disabled", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ localEnvironmentEnabled: false });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* fixture.run;
          assert.deepEqual(fixture.events, [
            "protocol",
            "ipc",
            "legacy-storage",
            "snapshot",
            "control-start",
            "window",
          ]);
        }),
      );
      assert.deepEqual(fixture.events.slice(-2), ["window", "control-release"]);
      assert.equal(fixture.events.filter((event) => event === "backend-start").length, 0);
    }),
  );

  it.effect("starts control exactly once before the enabled embedded backend", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ localEnvironmentEnabled: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* fixture.run;
          assert.deepEqual(fixture.events, [
            "protocol",
            "ipc",
            "legacy-storage",
            "snapshot",
            "control-start",
            "exposure-configure",
            "backend-start",
          ]);
        }),
      );
      assert.equal(fixture.events.filter((event) => event === "control-release").length, 1);
    }),
  );

  for (const localEnvironmentEnabled of [false, true]) {
    it.effect(
      `does not start control, backend or window while quitting (local=${localEnvironmentEnabled})`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeFixture({ localEnvironmentEnabled, quitting: true });
          yield* Effect.scoped(fixture.run);
          const forbiddenEvents: ReadonlyArray<Event> = [
            "control-start",
            "control-release",
            "backend-start",
            "window",
          ];
          for (const event of forbiddenEvents) {
            assert.equal(fixture.events.includes(event), false);
          }
        }),
    );

    it.effect(
      `keeps normal startup behavior after a bounded control failure (local=${localEnvironmentEnabled})`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeFixture({ localEnvironmentEnabled, controlFailure: true });
          yield* Effect.scoped(fixture.run);
          assert.equal(fixture.events.filter((event) => event === "control-start").length, 1);
          assert.equal(fixture.events.filter((event) => event === "control-release").length, 0);
          assert.equal(
            fixture.events.filter((event) => event === "backend-start").length,
            localEnvironmentEnabled ? 1 : 0,
          );
          assert.equal(
            fixture.events.filter((event) => event === "window").length,
            localEnvironmentEnabled ? 0 : 1,
          );
        }),
    );
  }
});
