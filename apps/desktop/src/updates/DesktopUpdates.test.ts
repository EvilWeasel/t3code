import { assert, describe, it } from "@effect/vitest";
import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { awaitUpdateState, flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

function ownedBackendFixture(
  name: string,
  steps: string[],
  options: { readonly refusal?: "prepare" | "commit" | "stale" | "busy"; readonly commit?: Effect.Effect<boolean>; readonly stop?: Effect.Effect<boolean>; readonly recover?: Effect.Effect<void>; readonly recoveryStatus?: "ready" | "held" | "superseded" } = {},
): DesktopBackendPool.DesktopBackendInstance {
  return {
    id: DesktopBackendPool.BackendInstanceId(name), label: Effect.succeed(name),
    start: Effect.sync(() => { steps.push(`recover:${name}`); }),
    stop: () => Effect.die("admitted update must not call unqualified raw stop"),
    currentConfig: Effect.succeedNone,
    snapshot: Effect.succeed({ desiredRunning: true, ready: options.refusal !== "busy", activePid: Option.some(123), restartAttempt: 0, restartScheduled: false }),
    waitForReady: () => Effect.succeed(true),
    prepareUpdate: (request) => Effect.sync(() => {
      steps.push(`prepare:${name}`);
      if (options.refusal === "prepare") return Option.none();
      return Option.some({
        instanceId: DesktopBackendPool.BackendInstanceId(name),
        context: { ...request, environmentId: name, bootId: `boot:${name}` }, persistedRunIds: [`eligible:${name}`],
        isValid: Effect.succeed(options.refusal !== "stale"),
        recover: (options.recover ?? Effect.sync(() => { steps.push(`recover:${name}`); })).pipe(Effect.as(options.recoveryStatus ?? "ready" as const)),
        commit: (options.commit ?? Effect.succeed(options.refusal !== "commit")).pipe(Effect.tap((accepted) => Effect.sync(() => {
          steps.push(`${accepted ? "committed" : "refused"}:${name}`);
        }))),
        abort: Effect.sync(() => { steps.push(`abort:${name}`); return true; }),
      });
    }),
    stopForUpdate: () => Effect.sync(() => { steps.push(`stop:${name}`); }).pipe(Effect.andThen(options.stop ?? Effect.succeed(true))),
  };
}

describe("DesktopUpdates", () => {
  it.effect("observes both already-published and later update outcomes without replaying an action", () => {
    const harness = makeHarness({ omitInstallQualification: true });
    return Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      const { changes } = yield* updates.subscribe;
      const firstPublished = yield* changes.pipe(
        Stream.filter((state) => state.downloadedVersion === "1.2.4"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      harness.emit("update-downloaded", { version: "1.2.4" });
      assert.isTrue(Option.isSome(yield* Fiber.join(firstPublished)));
      const alreadyPublished = yield* awaitUpdateState(updates, (state) => state.downloadedVersion === "1.2.4");
      assert.equal(alreadyPublished.downloadedVersion, "1.2.4");

      const later = yield* awaitUpdateState(updates, (state) => state.downloadedVersion === "1.2.5").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      harness.emit("update-available", { version: "1.2.5" });
      yield* awaitUpdateState(updates, (state) => state.availableVersion === "1.2.5");
      harness.emit("update-downloaded", { version: "1.2.5" });
      assert.equal((yield* Fiber.join(later)).downloadedVersion, "1.2.5");
      assert.equal(harness.checkCount(), 0);
      assert.equal(harness.quitAndInstalls(), 0);
      assert.equal(harness.stopCount(), 0);
    })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps the production default staged when the qualification service is completely absent", () => {
    const harness = makeHarness({ clientOnlyInventory: [], omitInstallQualification: true });
    return Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      assert.equal(harness.quitAndInstalls(), 0);
      assert.equal(harness.stopCount(), 0);
      const state = yield* updates.getState;
      assert.equal(state.downloadedVersion, "1.2.4");
      assert.isUndefined(state.installLease);
    })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("leaves automatic installation off without complete runtime creation qualification", () => {
    const harness = makeHarness({ clientOnlyInventory: [], clientOnlyInstallQualified: false });
    return Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      assert.equal(harness.quitAndInstalls(), 0);
      assert.equal(harness.stopCount(), 0);
      assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
    })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("refuses a revoked reservation after renderer validation without stopping a backend", () => {
    let valid = true;
    let commits = 0;
    return Effect.scoped(Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const harness = makeHarness({
        clientOnlyInventory: [{ id: 7, generation: "frame-1", audible: false }],
        runtimeReservation: { isValid: () => valid, tryCommit: () => { commits += 1; return valid; } },
        runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.scoped(Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const acknowledge = updates.acknowledgeReadiness;
        if (acknowledge === undefined) return yield* Effect.die("missing readiness service");
        const { changes } = yield* updates.subscribe;
        yield* Stream.runForEach(changes, (state) => {
          const lease = state.installLease;
          if (lease === undefined) return Effect.void;
          return Effect.gen(function* () {
            // A native activity/creation event revokes proof after prepare has
            // completed, before the final renderer acknowledgement is accepted.
            if (lease.phase === "validate") valid = false;
            yield* acknowledge(7, { lease, ready: true });
          });
        }).pipe(Effect.forkScoped);
        yield* TestClock.adjust(Duration.seconds(15));
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* TestClock.adjust(Duration.seconds(45));
        yield* Deferred.await(released);
        assert.equal(harness.quitAndInstalls(), 0);
        assert.equal(harness.stopCount(), 0);
        assert.equal(commits, 0);
        assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
      })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }));
  });

  it.effect("refuses an acquisition or final commit refusal and releases the runtime reservation", () =>
    Effect.gen(function* () {
      for (const refusal of ["acquire", "commit"] as const) {
        let commits = 0;
        let releases = 0;
        const released = yield* Deferred.make<void>();
        const harness = makeHarness({
          clientOnlyInventory: [],
          runtimeReservation: {
            isValid: () => refusal !== "acquire",
            tryCommit: () => { commits += 1; return false; },
          },
          onRuntimeReservationReleased: () => { releases += 1; },
          runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
        });
        yield* Effect.scoped(Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* TestClock.adjust(Duration.seconds(15));
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          yield* TestClock.adjust(Duration.seconds(45));
          yield* Deferred.await(released);
          assert.equal(harness.quitAndInstalls(), 0, refusal);
          assert.equal(harness.stopCount(), 0, refusal);
          assert.equal(commits, refusal === "commit" ? 1 : 0, refusal);
          assert.equal(releases, 1, refusal);
          assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
        })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }
    }),
  );

  it.effect("rechecks live proof at the installer after an asynchronous install-record write", () =>
    Effect.scoped(Effect.gen(function* () {
      const recordStarted = yield* Deferred.make<void>();
      const finishRecord = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      let valid = true;
      const harness = makeHarness({
        clientOnlyInventory: [],
        runtimeReservation: { isValid: () => valid, tryCommit: () => true },
        beforeWriteInstallRecord: Deferred.succeed(recordStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishRecord)),
        ),
        runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.scoped(Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const desktopState = yield* DesktopState.DesktopState;
        yield* updates.configure;
        yield* TestClock.adjust(Duration.seconds(15));
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* TestClock.adjust(Duration.seconds(45));
        yield* Deferred.await(recordStarted);
        // Actual I/O yields after tryCommit. A creator/activity event can revoke
        // the same token before the adapter invokes its native installer.
        valid = false;
        yield* Deferred.succeed(finishRecord, undefined);
        yield* Deferred.await(released);
        assert.equal(harness.quitAndInstalls(), 0);
        assert.equal(harness.stopCount(), 0);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.isUndefined(state.installLease);
      })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    })),
  );

  it.effect("retains the exact install record when Nix activated but relaunch admission was revoked", () =>
    Effect.scoped(Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const harness = makeHarness({
        clientOnlyInventory: [],
        quitAndInstall: Effect.fail(new ElectronUpdater.ElectronUpdaterNixActivationAdmissionError({
          selectedVersion: "1.2.4", runningVersion: "1.2.3",
        })),
        runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.scoped(Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* TestClock.adjust(Duration.seconds(15));
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* TestClock.adjust(Duration.seconds(45));
        yield* Deferred.await(released);
        assert.equal(harness.stopCount(), 0);
        assert.equal(harness.quitAndInstalls(), 1); // Activation was attempted: never claim zero mutation.
        assert.equal(harness.installRecords.size, 1);
        assert.deepEqual(JSON.parse([...harness.installRecords.values()][0]!), {
          fromVersion: "1.2.3", targetVersion: "1.2.4",
        });
        const state = yield* updates.getState;
        assert.equal(state.currentVersion, "1.2.3");
        assert.equal(state.errorContext, "install");
        assert.include(state.message ?? "", "Nix closure activated");
      })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    })),
  );

  it.effect("releases a committed client window after an asynchronous installer failure without starting backends", () => {
    let released = false;
    const harness = makeHarness({ clientOnlyInventory: [], onRuntimeReservationReleased: () => { released = true; } });
    return Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      assert.equal(harness.quitAndInstalls(), 1);
      assert.isFalse(released);
      const recovered = yield* awaitUpdateState(
        updates,
        (state) => state.errorContext === "install" && state.installLease === undefined,
      ).pipe(Effect.forkScoped);
      yield* flushCallbacks;
      harness.emit("error", new Error("installer failed after accepting the handoff"));
      const recoveredState = yield* Fiber.join(recovered);
      assert.equal(recoveredState.errorContext, "install");
      assert.isUndefined(recoveredState.installLease);
      assert.isTrue(released);
      assert.equal(harness.stopCount(), 0);
      assert.deepEqual(harness.installSteps, ["quitAndInstall"]);
    })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("installs a verified idle client without stopping or starting any backend", () => {
    const harness = makeHarness({ clientOnlyInventory: [{ id: 7, generation: "frame-1", audible: false }] });
    return Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      const acknowledge = updates.acknowledgeReadiness;
      if (acknowledge === undefined) return yield* Effect.die("missing readiness service");
      const { changes } = yield* updates.subscribe;
      yield* Stream.runForEach(changes, (state) => state.installLease === undefined
        ? Effect.void : acknowledge(7, { lease: state.installLease, ready: true }).pipe(Effect.asVoid),
      ).pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      yield* flushCallbacks;
      assert.equal(harness.quitAndInstalls(), 1);
      assert.equal(harness.stopCount(), 0);
      assert.deepEqual(harness.installSteps, ["quitAndInstall"]);
    })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps the update staged with zero process stops for busy, missing or stale renderer proof", () =>
    Effect.gen(function* () {
      for (const proof of ["busy", "missing", "stale", "expired", "wrong-sender"] as const) {
        const harness = makeHarness({ clientOnlyInventory: [{ id: 7, generation: "frame-1", audible: false }] });
        yield* Effect.scoped(Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const acknowledge = updates.acknowledgeReadiness;
          if (acknowledge === undefined) return yield* Effect.die("missing readiness service");
          const { changes } = yield* updates.subscribe;
          yield* Stream.runForEach(changes, (state) => {
            const lease = state.installLease;
            if (lease === undefined || proof === "missing") return Effect.void;
            return acknowledge(proof === "wrong-sender" ? 8 : 7, {
              lease: { ...lease,
                generation: proof === "stale" ? "old-generation" : lease.generation,
                expiresAt: proof === "expired" ? 0 : lease.expiresAt,
              }, ready: proof !== "busy",
            }).pipe(Effect.asVoid);
          }).pipe(Effect.forkScoped);
          yield* TestClock.adjust(Duration.seconds(15));
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          yield* TestClock.adjust(Duration.seconds(45));
          yield* TestClock.adjust(Duration.seconds(6));
          assert.equal(harness.quitAndInstalls(), 0, proof);
          assert.equal(harness.stopCount(), 0, proof);
          assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
        })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }
    }),
  );

  it.effect("never installs or stops a backend whose desired state can restart a process", () => {
    const harness = makeHarness({ clientOnlyInventory: [], backendSnapshot: Effect.succeed({
      desiredRunning: true, ready: false, activePid: Option.none(), restartAttempt: 0, restartScheduled: false,
    }) });
    return Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      assert.equal(harness.quitAndInstalls(), 0);
      assert.equal(harness.stopCount(), 0);
    })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("prepares and commits ALL owned backends before stopping any of them", () =>
    Effect.scoped(Effect.gen(function* () {
      const steps: string[] = [];
      const commitStarted = yield* Deferred.make<void>();
      const finishCommit = yield* Deferred.make<void>();
      const installed = yield* Deferred.make<void>();
      const harness = makeHarness({
        clientOnlyInventory: [],
        backendInstances: [ownedBackendFixture("primary", steps), ownedBackendFixture("wsl", steps, {
          commit: Deferred.succeed(commitStarted, undefined).pipe(Effect.andThen(Deferred.await(finishCommit)), Effect.as(true)),
        })],
        quitAndInstall: Effect.sync(() => { steps.push("native"); }).pipe(Effect.andThen(Deferred.succeed(installed, undefined)), Effect.asVoid),
      });
      yield* Effect.scoped(Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* TestClock.adjust(Duration.seconds(15));
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* TestClock.adjust(Duration.seconds(45));
        yield* Deferred.await(commitStarted);
        assert.isFalse(steps.some((step) => step.startsWith("stop:")));
        assert.equal(harness.quitAndInstalls(), 0);
        yield* Deferred.succeed(finishCommit, undefined);
        yield* Deferred.await(installed);
        const firstStop = steps.findIndex((step) => step.startsWith("stop:"));
        assert.isAbove(firstStop, steps.indexOf("committed:primary"));
        assert.isAbove(firstStop, steps.indexOf("committed:wsl"));
        assert.isAbove(steps.indexOf("native"), steps.indexOf("stop:primary"));
        assert.isAbove(steps.indexOf("native"), steps.indexOf("stop:wsl"));
        assert.isFalse(steps.some((step) => step.startsWith("abort:")));
      })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    })),
  );

  it.effect("keeps the update staged and aborts prepared peers on any owned refusal with ZERO stops", () =>
    Effect.gen(function* () {
      for (const refusal of ["prepare", "commit", "stale", "busy"] as const) {
        const steps: string[] = [];
        const released = yield* Deferred.make<void>();
        const harness = makeHarness({ clientOnlyInventory: [],
          backendInstances: [ownedBackendFixture("primary", steps), ownedBackendFixture("wsl", steps, { refusal })],
          runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
        });
        yield* Effect.scoped(Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* TestClock.adjust(Duration.seconds(15));
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          yield* TestClock.adjust(Duration.seconds(45));
          yield* Deferred.await(released);
          assert.isFalse(steps.some((step) => step.startsWith("stop:")), refusal);
          assert.isTrue(steps.includes("abort:primary"), refusal);
          assert.equal(harness.quitAndInstalls(), 0, refusal);
          assert.equal((yield* updates.getState).status, "downloaded", refusal);
        })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }
    }),
  );

  it.effect("aborts all committed peers without stopping when the batch expires during a delayed commit ACK", () =>
    Effect.scoped(Effect.gen(function* () {
      const commitStarted = yield* Deferred.make<void>();
      const finishCommit = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const steps: string[] = [];
      const harness = makeHarness({ clientOnlyInventory: [],
        backendInstances: [ownedBackendFixture("primary", steps), ownedBackendFixture("secondary", steps, {
          commit: Deferred.succeed(commitStarted, undefined).pipe(Effect.andThen(Deferred.await(finishCommit)), Effect.as(true)),
        })],
        runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.scoped(Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* TestClock.adjust(Duration.seconds(15));
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* TestClock.adjust(Duration.seconds(45));
        yield* Deferred.await(commitStarted);
        yield* TestClock.adjust(Duration.seconds(30));
        yield* Deferred.succeed(finishCommit, undefined);
        yield* Deferred.await(released);
        assert.isTrue(steps.includes("committed:primary"));
        assert.isTrue(steps.includes("committed:secondary"));
        assert.isTrue(steps.includes("abort:primary"));
        assert.isTrue(steps.includes("abort:secondary"));
        assert.isFalse(steps.some((step) => step.startsWith("stop:")));
        assert.equal(harness.quitAndInstalls(), 0);
        assert.equal((yield* updates.getState).status, "downloaded");
      })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    })),
  );

  it.effect("refuses local installation on an unverifiable install-record write before ANY owned stop", () =>
    Effect.scoped(Effect.gen(function* () {
      const steps: string[] = [];
      const released = yield* Deferred.make<void>();
      const harness = makeHarness({ clientOnlyInventory: [], backendInstances: [ownedBackendFixture("primary", steps)],
        beforeWriteInstallRecord: Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "writeFileString" })),
        runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.scoped(Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* TestClock.adjust(Duration.seconds(15));
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        yield* TestClock.adjust(Duration.seconds(45));
        yield* Deferred.await(released);
        assert.isFalse(steps.some((step) => step.startsWith("stop:")));
        assert.isTrue(steps.includes("abort:primary"));
        assert.equal(harness.quitAndInstalls(), 0);
        assert.equal((yield* updates.getState).status, "downloaded");
      })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    })),
  );

  it.effect("only enables the packaged fork feed and never polls upstream or custom hosts", () =>
    Effect.gen(function* () {
      for (const [feed, enabled] of [
        ["provider: github\nowner: morrowbyte\nrepo: t3code\n", true],
        ["provider: 'github'\nowner: 'morrowbyte'\nrepo: 't3code'\n", true],
        ["provider: github\nowner: pingdotgg\nrepo: t3code\n", false],
        ["provider: github\nowner: morrowbyte\nrepo: other\n", false],
        ["provider: github\nowner: morrowbyte\nrepo: t3code\nhost: other.example\n", false],
        ["provider: github\nowner: morrowbyte\nrepo: t3code\nprotocol: http\n", false],
        ["provider: generic\nurl: https://example.com\n", false],
      ] as const) {
        const harness = makeHarness({
          appUpdateYml: feed,
          env: { T3CODE_DESKTOP_MOCK_UPDATES: "false" },
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            assert.equal((yield* updates.getState).enabled, enabled);
            if (!enabled) {
              assert.equal((yield* updates.check("manual")).checked, false);
              assert.equal(harness.checkCount(), 0);
              assert.equal(harness.listenerCount(), 0);
            }
          }),
        ).pipe(Effect.provide(harness.layer));
      }
    }),
  );

  it.effect("prepares a startup update automatically without stopping a backend or installing", () =>
    Effect.gen(function* () {
      const downloadStarted = yield* Deferred.make<void>();
      const finishDownload = yield* Deferred.make<void>();
      let publishAvailable: () => void = () => {
        throw new Error("Update publisher has not been attached");
      };
      const harness = makeHarness({
        checkForUpdates: Effect.sync(() => publishAvailable()).pipe(Effect.andThen(flushCallbacks)),
        downloadUpdate: Deferred.succeed(downloadStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishDownload)),
        ),
      });
      publishAvailable = () => harness.emit("update-available", { version: "1.2.4" });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* TestClock.adjust(Duration.seconds(15));
          yield* Deferred.await(downloadStarted);
          assert.equal(harness.downloadCount(), 1);
          assert.equal((yield* updates.getState).status, "downloading");
          assert.equal((yield* updates.download).accepted, false);
          assert.equal((yield* updates.check("manual")).checked, false);
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* Deferred.succeed(finishDownload, undefined);
          yield* flushCallbacks;
          assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
          assert.equal(harness.quitAndInstalls(), 0);
          assert.deepEqual(harness.installSteps, []);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("rejects previews and wrong-channel downloads before they become installable", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        for (const version of [
          "1.2.4-preview.20261015.1",
          "1.2.4-pr.42",
          "1.2.4-nightly.20261015.1",
        ]) {
          harness.emit("update-available", { version });
          harness.emit("update-downloaded", { version });
          yield* flushCallbacks;
          assert.isNull((yield* updates.getState).downloadedVersion);
          assert.equal((yield* updates.download).accepted, false);
          assert.equal((yield* updates.install).accepted, false);
        }
        assert.equal(harness.downloadCount(), 0);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not admit a downloaded artifact for a different release version", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.5" });
        yield* flushCallbacks;
        assert.isNull((yield* updates.getState).downloadedVersion);
        assert.equal((yield* updates.install).accepted, false);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it("preserves complete causes for update poller and event failures", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("updater failed")),
      Cause.die(new Error("updater defect")),
    );
    const pollerError = new DesktopUpdates.DesktopUpdatePollerError({
      poller: "startup",
      cause,
    });
    const eventError = new DesktopUpdates.DesktopUpdateEventHandlingError({
      event: "download-progress",
      cause,
    });
    const reportedError = new DesktopUpdates.DesktopUpdaterReportedError({
      operation: "download",
      cause,
    });
    const unexpectedActionError = new DesktopUpdates.DesktopUpdateUnexpectedActionError({
      action: "install",
      cause,
    });

    assert.strictEqual(pollerError.cause, cause);
    assert.equal(pollerError.poller, "startup");
    assert.equal(pollerError.message, "Desktop update startup poller failed.");
    assert.strictEqual(eventError.cause, cause);
    assert.equal(eventError.event, "download-progress");
    assert.equal(eventError.message, "Failed to handle desktop update download-progress event.");
    assert.strictEqual(reportedError.cause, cause);
    assert.equal(reportedError.operation, "download");
    assert.equal(reportedError.message, "Desktop updater download operation reported an error.");
    assert.strictEqual(unexpectedActionError.cause, cause);
    assert.equal(unexpectedActionError.action, "install");
    assert.equal(
      unexpectedActionError.message,
      "Desktop update install action failed unexpectedly.",
    );
  });

  it.effect("configures the updater and runs startup checks on the test clock", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const state = yield* updates.getState;
          assert.equal(state.enabled, true);
          assert.equal(state.status, "idle");
          assert.deepEqual(harness.feedUrls(), [
            { provider: "generic", url: "http://localhost:4141" },
          ]);
          assert.equal(harness.listenerCount(), 6);
          assert.equal(harness.checkCount(), 0);

          yield* TestClock.adjust(Duration.millis(15_000));
          assert.equal(harness.checkCount(), 1);
        }),
      );

      assert.equal(harness.listenerCount(), 0);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("updates Linux .deb installs and leaves other non-AppImage installs off", () =>
    Effect.gen(function* () {
      const linuxState = (packageType: string | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            return yield* updates.getState;
          }),
        ).pipe(Effect.provide(makeHarness({ platform: "linux", packageType }).layer));

      const deb = yield* linuxState("deb\n");
      assert.equal(deb.status, "idle");

      const unmarked = yield* linuxState(undefined);
      assert.equal(unmarked.status, "disabled");
    }),
  );

  it.effect("uses the managed Nix updater without an AppImage or electron feed", () => {
    const harness = makeHarness({
      platform: "linux",
      env: {
        T3CODE_DESKTOP_MOCK_UPDATES: "false",
        T3CODE_NIX_UPDATER: "/nix/store/package/libexec/t3code-weasel-update",
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.getState).enabled, true);
        assert.deepEqual(harness.feedUrls(), []);
        assert.equal(harness.listenerCount(), 6);
        yield* updates.check("managed-nix-test");
        assert.equal(harness.checkCount(), 1);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("subscribe delivers the latest state plus subsequent changes", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const { latest, changes } = yield* updates.subscribe;
        assert.equal(latest.status, "idle");

        const nextState = yield* Stream.runHead(changes).pipe(Effect.forkChild);
        yield* flushCallbacks;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const observed = yield* Fiber.join(nextState);
        assert.equal(Option.getOrThrow(observed).status, "available");
        assert.equal(Option.getOrThrow(observed).availableVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("updates and broadcasts state from updater events", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.4");
        assert.isNotNull(state.checkedAt);
        assert.equal(harness.sentStates.at(-1)?.status, "available");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("enables nightly full changelog release notes and broadcasts summaries", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.setChannel("nightly");
        assert.equal(harness.fullChangelog(), true);

        harness.emit("update-available", {
          version: "1.2.4-nightly.20260709.766",
          releaseNotes: [
            {
              version: "1.2.4-nightly.20260709.766",
              note: `<h2>What's Changed</h2><ul><li>feat(client): persist offline environment data by <a>@juliusmarminge</a> in <a>#3795</a></li></ul><h2>Full Changelog</h2>`,
            },
            {
              version: "1.2.4-nightly.20260709.765",
              note: "- [codex] Upgrade Clerk stack by @juliusmarminge in #3821",
            },
            { version: "1.2.4-nightly.20260709.764", note: "- Change 764" },
            { version: "1.2.4-nightly.20260709.763", note: "- Change 763" },
            { version: "1.2.4-nightly.20260709.762", note: "- Change 762" },
            { version: "1.2.4-nightly.20260709.761", note: "- Change 761" },
            { version: "1.2.4-nightly.20260709.760", note: "- Change 760" },
          ],
        });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.deepEqual(state.releaseNotes, [
          {
            version: "1.2.4-nightly.20260709.766",
            items: ["feat(client): persist offline environment data by @juliusmarminge in #3795"],
            totalItems: 1,
          },
          {
            version: "1.2.4-nightly.20260709.765",
            items: ["[codex] Upgrade Clerk stack by @juliusmarminge in #3821"],
            totalItems: 1,
          },
          { version: "1.2.4-nightly.20260709.764", items: ["Change 764"], totalItems: 1 },
          { version: "1.2.4-nightly.20260709.763", items: ["Change 763"], totalItems: 1 },
          { version: "1.2.4-nightly.20260709.762", items: ["Change 762"], totalItems: 1 },
          { version: "1.2.4-nightly.20260709.761", items: ["Change 761"], totalItems: 1 },
        ]);
        assert.equal(state.omittedReleaseCount, 1);
        assert.deepEqual(harness.sentStates.at(-1)?.releaseNotes, state.releaseNotes);
        assert.equal(harness.sentStates.at(-1)?.omittedReleaseCount, 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("checks for newer releases after an update has been downloaded", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.check("poll");
        assert.isTrue(result.checked);

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const unchangedState = yield* updates.getState;
        assert.equal(unchangedState.status, "downloaded");
        assert.equal(unchangedState.downloadedVersion, "1.2.4");
        assert.deepEqual(unchangedState.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(unchangedState.omittedReleaseCount, 0);

        const nextResult = yield* updates.check("poll");
        assert.isTrue(nextResult.checked);

        harness.emit("update-available", { version: "1.2.5" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.5");
        assert.isNull(state.downloadedVersion);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("preserves a queued installer when the feed has no update", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.check("poll");
        harness.emit("update-not-available");
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.availableVersion, "1.2.4");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.deepEqual(state.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(state.omittedReleaseCount, 0);
        assert.equal(state.downloadPercent, 100);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("preserves a queued installer when the feed offers another channel", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.check("poll");
        harness.emit("update-available", { version: "1.2.5-nightly.20260710.1" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.availableVersion, "1.2.4");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.deepEqual(state.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(state.omittedReleaseCount, 0);
        assert.equal(state.downloadPercent, 100);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect(
    "rejects install while a refresh check is in progress and releases the reservation",
    () =>
      Effect.gen(function* () {
        const checkStarted = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const harness = makeHarness({
          checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCheck)),
          ),
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* flushCallbacks;

            const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
            yield* Deferred.await(checkStarted);

            const installResult = yield* updates.install;
            assert.isFalse(installResult.accepted);

            yield* Deferred.succeed(releaseCheck, undefined);
            const checkResult = yield* Fiber.join(checkFiber);
            assert.isTrue(checkResult.checked);

            const followUpCheck = yield* updates.check("manual");
            assert.isTrue(followUpCheck.checked);
            assert.equal(harness.checkCount(), 2);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );

  it.effect("rejects refresh checks while install is in progress", () =>
    Effect.gen(function* () {
      const installStarted = yield* Deferred.make<void>();
      const releaseInstall = yield* Deferred.make<void>();
      const harness = makeHarness({
        stopBackend: Deferred.succeed(installStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInstall)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(installStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseInstall, undefined);
          const installResult = yield* Fiber.join(installFiber);
          assert.isTrue(installResult.accepted);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("keeps raw updater event failures out of update state", () => {
    const harness = makeHarness();
    const cause = new Error(
      "request failed for https://user:secret@example.com/update?token=secret",
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("error", cause);
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "error");
        assert.equal(state.message, "Desktop updater background operation reported an error.");
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("preserves a queued installer after a background updater error", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        harness.emit("error", new Error("background updater failure"));
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "error");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.isNull(state.errorContext);

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("logs the redacted cause of a rejected update check", () => {
    const cause = Object.assign(
      new Error("request failed for https://user:secret@example.com/update?token=secret"),
      { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" },
    );
    const updaterError = new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
      channel: null,
      cause,
    });
    const harness = makeHarness({ checkForUpdates: Effect.fail(updaterError) });
    const loggedAnnotations: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      if (annotations.errorTag === "ElectronUpdaterCheckForUpdatesError") {
        loggedAnnotations.push(annotations);
      }
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.check("manual");

        const state = yield* updates.getState;
        const loggedAnnotation = loggedAnnotations.at(-1);
        assert.isDefined(loggedAnnotation);
        assert.equal(loggedAnnotation.errorTag, "ElectronUpdaterCheckForUpdatesError");
        assert.isNull(loggedAnnotation.channel);
        assert.equal(
          loggedAnnotation.cause,
          "Error [ERR_UPDATER_LATEST_VERSION_NOT_FOUND]: request failed for [redacted URL]",
        );
        assert.notProperty(loggedAnnotation, "error");
        assert.notInclude(Object.values(loggedAnnotation).map(String).join(" "), "secret");
        assert.equal(
          state.message,
          "Electron updater failed to check for updates on channel default.",
        );
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          harness.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("logs the redacted cause of an updater error event", () => {
    const harness = makeHarness();
    const cause = Object.assign(new Error("404 Not Found\nHeaders: authorization=secret"), {
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
    const loggedAnnotations: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      if (annotations.errorTag === "DesktopUpdaterReportedError") {
        loggedAnnotations.push(annotations);
      }
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("error", cause);
        yield* flushCallbacks;

        const loggedAnnotation = loggedAnnotations.at(-1);
        assert.isDefined(loggedAnnotation);
        assert.equal(loggedAnnotation.operation, "background");
        assert.equal(
          loggedAnnotation.cause,
          "Error [ERR_UPDATER_CHANNEL_FILE_NOT_FOUND]: 404 Not Found",
        );
        assert.notInclude(JSON.stringify(loggedAnnotations), "secret");
        const state = yield* updates.getState;
        assert.equal(state.message, "Desktop updater background operation reported an error.");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          harness.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("recovers download state after an unexpected setup failure", () => {
    let disableDifferentialCalls = 0;
    const harness = makeHarness({
      setDisableDifferentialDownload: Effect.suspend(() => {
        disableDifferentialCalls += 1;
        return disableDifferentialCalls === 1
          ? Effect.void
          : Effect.die(new Error("download setup failed"));
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "available");
        assert.equal(failedState.errorContext, "download");
        assert.equal(failedState.message, "Desktop update download action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores download state and permits retry after interruption", () =>
    Effect.gen(function* () {
      const actionStarted = yield* Deferred.make<void>();
      let disableDifferentialCalls = 0;
      const harness = makeHarness({
        setDisableDifferentialDownload: Effect.suspend(() => {
          disableDifferentialCalls += 1;
          if (disableDifferentialCalls === 1) {
            return Effect.void;
          }
          if (disableDifferentialCalls === 2) {
            return Deferred.succeed(actionStarted, undefined).pipe(Effect.andThen(Effect.never));
          }
          return Effect.void;
        }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;

          const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
          yield* Deferred.await(actionStarted);
          yield* Fiber.interrupt(downloadFiber);

          const interruptedState = yield* updates.getState;
          assert.equal(interruptedState.status, "available");
          assert.isNull(interruptedState.message);

          const retry = yield* updates.download;
          assert.isTrue(retry.accepted);
          assert.isTrue(retry.completed);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("clears quitting state after an unexpected install setup failure", () => {
    const harness = makeHarness({
      stopBackend: Effect.die(new Error("backend stop failed")),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);
        assert.isFalse(yield* Ref.get(desktopState.quitting));

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "downloaded");
        assert.equal(failedState.errorContext, "install");
        assert.equal(failedState.message, "Desktop update install action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("marks the backend stop for an install as an update restart", () => {
    let markersAtStop: ReadonlyArray<string> = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        markersAtStop = [...harness.updateRestartMarkers];
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.isTrue((yield* updates.install).accepted);
        assert.deepEqual(markersAtStop, [
          environment.path.join(environment.baseDir, "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE),
        ]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("records the version an install hands to the installer", () => {
    let recordsAtStop: ReadonlyArray<string> = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        recordsAtStop = [...harness.installRecords.values()];
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.isTrue((yield* updates.install).accepted);
        assert.deepEqual(
          recordsAtStop.map((record) => JSON.parse(record)),
          [{ fromVersion: "1.2.3", targetVersion: "1.2.4" }],
        );
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("flags an install that did not apply and keeps the flag through checks", () => {
    const harness = makeHarness({
      installRecord: JSON.stringify({ fromVersion: "1.2.3", targetVersion: "1.2.4" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.getState).notAppliedVersion, "1.2.4");
        // Kept, so the next start on 1.2.3 still knows 1.2.4 did not apply.
        assert.isDefined(harness.previousInstallRecord());

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.notAppliedVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not flag an install that applied", () => {
    const harness = makeHarness({
      installRecord: JSON.stringify({ fromVersion: "1.2.2", targetVersion: "1.2.3" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.isUndefined((yield* updates.getState).notAppliedVersion);
        assert.isUndefined(harness.previousInstallRecord());
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not attribute an unrelated version or malformed record to a failed install", () =>
    Effect.gen(function* () {
      for (const installRecord of [
        JSON.stringify({ fromVersion: "1.2.1", targetVersion: "1.2.2" }),
        '{"fromVersion":false}',
      ]) {
        const harness = makeHarness({ installRecord });
        yield* Effect.scoped(Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.isUndefined((yield* updates.getState).notAppliedVersion);
          assert.isUndefined(harness.previousInstallRecord());
        })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }
    }),
  );

  it.effect("does not automatically retry an exact version whose install did not apply", () => {
    const harness = makeHarness({
      clientOnlyInventory: [],
      installRecord: JSON.stringify({ fromVersion: "1.2.3", targetVersion: "1.2.4" }),
    });
    return Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      assert.equal(harness.quitAndInstalls(), 0);
      assert.equal(harness.stopCount(), 0);
      assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
    })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("drops the update restart marker when an install is interrupted", () =>
    Effect.gen(function* () {
      const stopping = yield* Deferred.make<void>();
      const harness = makeHarness({
        stopBackend: Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Effect.never)),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(stopping);
          assert.equal(harness.updateRestartMarkers.size, 1);

          yield* Fiber.interrupt(installFiber);
          assert.equal(harness.updateRestartMarkers.size, 0);
          assert.equal(harness.installRecords.size, 0);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("keeps windows and restarts backends when quitAndInstall fails", () => {
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);
        // The restarted old backend must release its tunnel on a later quit.
        assert.equal(harness.updateRestartMarkers.size, 0);
        // The app never quit, so the next start must not report an unapplied install.
        assert.equal(harness.installRecords.size, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("holds the install reservation until failed-install recovery finishes", () => {
    const recoveryStarted = Deferred.makeUnsafe<void>();
    const releaseRecovery = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
      startBackend: Deferred.succeed(recoveryStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRecovery)),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const failedInstall = yield* updates.install.pipe(Effect.forkChild);
        yield* Deferred.await(recoveryStarted);
        assert.isFalse(yield* updates.isInstallActive);

        const overlappingInstall = yield* updates.install;
        assert.isFalse(overlappingInstall.accepted);
        assert.equal(harness.quitAndInstalls(), 1);
        harness.emit("error", new Error("duplicate native installer error"));
        yield* flushCallbacks;
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);

        yield* Deferred.succeed(releaseRecovery, undefined);
        const failedResult = yield* Fiber.join(failedInstall);
        assert.equal(failedResult.state.errorContext, "install");

        const retry = yield* updates.install;
        assert.isTrue(retry.accepted);
        assert.equal(harness.quitAndInstalls(), 2);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("recovers when quitAndInstall reports failure through an updater event", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.install;
        assert.deepEqual(harness.installSteps, ["quitAndInstall"]);
        harness.emit("error", new Error("native installer refused"));
        yield* flushCallbacks;

        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);
        assert.equal((yield* updates.getState).errorContext, "install");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("rejects a prepared install when the downloaded version changed", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.5" });
        yield* flushCallbacks;

        const result = yield* updates.installPrepared("1.2.4");
        assert.isFalse(result.accepted);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("persists channel changes through the settings service", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("nightly");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "nightly");
        assert.equal(persistedSettings.updateChannel, "nightly");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, true);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not persist an unchanged update channel as a user preference", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("latest");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "latest");
        assert.equal(persistedSettings.updateChannel, "latest");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, false);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("fails channel changes with a typed error while a check is in progress", () =>
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const harness = makeHarness({
        checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheck)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
          yield* Deferred.await(checkStarted);

          const exit = yield* Effect.exit(updates.setChannel("nightly"));
          assert.equal(exit._tag, "Failure");
          if (exit._tag === "Failure") {
            const error = Cause.squash(exit.cause);
            assert.instanceOf(error, DesktopUpdates.DesktopUpdateActionInProgressError);
            assert.equal(error.action, "check");
            assert.equal(error.requestedChannel, "nightly");
          }

          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(checkFiber);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("rejects checks while an update channel change is being persisted", () =>
    Effect.gen(function* () {
      const channelChangeStarted = yield* Deferred.make<void>();
      const releaseChannelChange = yield* Deferred.make<void>();
      const harness = makeHarness({
        beforeSetUpdateChannel: Deferred.succeed(channelChangeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseChannelChange)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const channelFiber = yield* updates.setChannel("nightly").pipe(Effect.forkScoped);
          yield* Deferred.await(channelChangeStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseChannelChange, undefined);
          const state = yield* Fiber.join(channelFiber);

          assert.equal(state.channel, "nightly");
          assert.equal(harness.checkCount(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("preserves settings failure context when an update channel cannot be persisted", () => {
    const diskFailure = new Error("disk exploded");
    const settingsFailure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/tmp/settings.json",
      cause: diskFailure,
    });
    const harness = makeHarness({ setUpdateChannelError: settingsFailure });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);

        assert.instanceOf(error, DesktopUpdates.DesktopUpdateChannelPersistenceError);
        assert.equal(error.channel, "nightly");
        assert.strictEqual(error.cause, settingsFailure);
        assert.strictEqual(error.cause.cause, diskFailure);
        assert.equal(error.message, "Failed to persist the nightly desktop update channel.");
        assert.notInclude(error.message, diskFailure.message);

        const checkResult = yield* updates.check("manual");
        assert.isTrue(checkResult.checked);
        assert.equal(harness.checkCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});

describe("describeUpdateErrorCause", () => {
  it("preserves network and nested failure reasons", () => {
    const networkError = Object.assign(new Error("getaddrinfo ENOTFOUND updates.example.com"), {
      code: "ENOTFOUND",
    });
    const cause = new Error("fetch failed", { cause: networkError });

    assert.equal(
      DesktopUpdates.describeUpdateErrorCause(Cause.fail(cause)),
      "Error: fetch failed; caused by Error [ENOTFOUND]: getaddrinfo ENOTFOUND updates.example.com",
    );
    assert.include(DesktopUpdates.describeUpdateErrorCause(Cause.die(networkError)), "[ENOTFOUND]");
  });

  it("removes URLs, credentials, response bodies, and headers from summaries", () => {
    const messages = [
      "Cannot download https://user:url-secret@example.com/update?token=query-secret, status 403",
      "Request failed: Bearer bearer-secret",
      "Request failed: Basic basic-secret",
      "Request failed: Authorization: Bearer header-secret",
      "Request failed: Cookie=session-secret",
      "Request failed: api_key=\"key-secret\" password='password-secret' access_token=token-secret",
      '404 Not Found\n{"body":"body-secret"}\nHeaders: cookie=header-secret',
      "Request failed\rHeaders: cookie=header-secret",
    ];

    for (const message of messages) {
      const summary = DesktopUpdates.describeUpdateErrorCause(new Error(message));
      assert.include(summary, "Error:");
      assert.notInclude(summary, "secret");
      assert.notInclude(summary, "https://");
      assert.notInclude(summary, "Headers:");
    }
    assert.equal(
      DesktopUpdates.describeUpdateErrorCause("404 Not Found\nbody-secret"),
      "404 Not Found",
    );
  });

  it("bounds long messages, parallel failures, and cyclic causes", () => {
    const longError = new Error("x".repeat(10_000));
    const parallel = Cause.combine(Cause.fail(longError), Cause.die(longError));
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(parallel).length, 1024);

    const cyclic = new Error("retry failed");
    cyclic.cause = cyclic;
    assert.include(DesktopUpdates.describeUpdateErrorCause(cyclic), "[truncated cause]");
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(cyclic).length, 1024);
  });

  it("does not serialize arbitrary payloads or let unreadable errors break logging", () => {
    assert.equal(DesktopUpdates.describeUpdateErrorCause({ payload: "secret" }), "object");
    const unreadable = Object.defineProperty({}, "message", {
      get() {
        throw new Error("unreadable error");
      },
    });
    assert.equal(DesktopUpdates.describeUpdateErrorCause(unreadable), "UnknownError");
  });
});

it.effect("releases the held pool lane before canonical backend recovery after installer failure", () =>
  Effect.scoped(Effect.gen(function* () {
    const lane = yield* Semaphore.make(1);
    const recovered = yield* Deferred.make<void>();
    const steps: string[] = [];
    const harness = makeHarness({ clientOnlyInventory: [], inventoryLane: (use) => lane.withPermits(1)(use),
      backendInstances: [ownedBackendFixture("primary", steps, {
        recover: lane.withPermits(1)(Effect.sync(() => { steps.push("recovered"); }).pipe(Effect.andThen(Deferred.succeed(recovered, undefined)), Effect.asVoid)),
      })],
      quitAndInstall: Effect.fail(new ElectronUpdater.ElectronUpdaterQuitAndInstallError({ channel: "nightly", isSilent: true, isForceRunAfter: true, cause: "installer refused" })),
    });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      yield* Deferred.await(recovered);
      yield* awaitUpdateState(updates, (state) => state.errorContext === "install");
      assert.isTrue(steps.includes("stop:primary"));
      assert.isTrue(steps.includes("recovered"));
      assert.isFalse(steps.includes("abort:primary")); // A committed/stopped peer is never reopened by abort.
      assert.equal((yield* updates.getState).errorContext, "install");
    })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  })),
);

it.effect("uses explicit recovery after partial shutdown and never falsely reports zero stops", () =>
  Effect.scoped(Effect.gen(function* () {
    const recovered = yield* Deferred.make<void>();
    const steps: string[] = [];
    const harness = makeHarness({ clientOnlyInventory: [], backendInstances: [
      ownedBackendFixture("primary", steps),
      ownedBackendFixture("wsl", steps, { stop: Effect.succeed(false), recoveryStatus: "held", recover: Deferred.succeed(recovered, undefined).pipe(Effect.asVoid) }),
    ] });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      yield* Deferred.await(recovered);
      yield* awaitUpdateState(updates, (state) => state.errorContext === "install");
      assert.isTrue(steps.includes("stop:primary"));
      assert.isTrue(steps.includes("stop:wsl"));
      assert.isFalse(steps.some((step) => step.startsWith("abort:")));
      assert.equal(harness.quitAndInstalls(), 0);
      assert.equal((yield* updates.getState).errorContext, "install");
      assert.include((yield* updates.getState).message ?? "", "Recovery remains held for app-owned backends: wsl");
    })).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  })),
);

const previousDefer = (path: string) => JSON.stringify({ version: 1, profileKey: path.split(/[\\/]/).at(-1)!.slice(DesktopUpdates.DESKTOP_UPDATE_DEFER_RECORD_PREFIX.length, -5), profile: null, attemptId: "previous-owner:1", observedAt: 0,
  runningVersion: "1.2.3", targetVersion: "1.2.4", channel: "latest", phase: "deferred", reason: "runtime-busy", stopState: "not-started", peers: [] });
function completedDefer(harness: ReturnType<typeof makeHarness>) {
  const entries = [...harness.deferFiles].filter(([path]) => !path.includes(`.${DesktopUpdates.DESKTOP_UPDATE_DEFER_RECORD_PREFIX}`));
  assert.lengthOf(entries, 1);
  return { path: entries[0]![0], text: entries[0]![1], record: JSON.parse(entries[0]![1]) as {
    targetVersion: string; runningVersion: string; attemptId: string; reason: string; observedAt: number; profileKey: string;
    phase: string; stopState: string; peers: Array<{ instanceId: string; status: string; shutdown: string }>;
  } };
}

it.effect("restores only the recorded defer metadata after 24h and a fresh service without replaying an update", () =>
  Effect.gen(function* () {
    const files = new Map<string, string>();
    const released = yield* Deferred.make<void>();
    const first = makeHarness({ deferFiles: files, clientOnlyInventory: [], clientOnlyInstallQualified: false,
      runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid) });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust(Duration.seconds(15));
      first.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      yield* Deferred.await(released);
      assert.equal(completedDefer(first).record.reason, "runtime-unknown");
      assert.equal((yield* updates.getState).status, "downloaded");
      assert.equal(first.quitAndInstalls(), 0);
    })).pipe(Effect.provide(first.layer));
    const saved = completedDefer(first);
    yield* TestClock.adjust(Duration.hours(24));
    const second = makeHarness({ deferFiles: files, omitInstallQualification: true });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      const state = yield* updates.getState;
      assert.include(state.message ?? "", "runtime-unknown");
      assert.include(state.message ?? "", "1.2.4");
      assert.isNull(state.downloadedVersion); // Saved metadata is never an artifact or proof.
      assert.equal(second.quitAndInstalls(), 0);
      assert.equal(second.stopCount(), 0);
      assert.equal(second.checkCount(), 0);
      assert.equal(completedDefer(second).text, saved.text);
    })).pipe(Effect.provide(second.layer));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect.each(["write", "readback", "rename"] as const)("pre-stop defer storage %s failure preserves the previous record and performs ZERO stops/install", (failure) =>
  Effect.scoped(Effect.gen(function* () {
    const steps: string[] = [];
    const released = yield* Deferred.make<void>();
    const denied = PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "defer-fixture" });
    const harness = makeHarness({ clientOnlyInventory: [], deferRecord: previousDefer,
      backendInstances: [ownedBackendFixture("primary", steps)],
      ...(failure === "write" ? { beforeDeferWrite: Effect.fail(denied) } : {}),
      ...(failure === "rename" ? { beforeDeferRename: Effect.fail(denied) } : {}),
      ...(failure === "readback" ? { transformDeferRead: (path: string, text: string) => path.includes(`.${DesktopUpdates.DESKTOP_UPDATE_DEFER_RECORD_PREFIX}`) ? text + "corrupt" : text } : {}),
      runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
    });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      const hydrated = yield* updates.getState;
      assert.include(hydrated.message ?? "", "runtime-busy");
      assert.notInclude(hydrated.message ?? "", "storage is unavailable");
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      yield* Deferred.await(released);
      assert.isFalse(steps.some((step) => step.startsWith("stop:")));
      assert.equal(harness.quitAndInstalls(), 0);
      assert.equal(completedDefer(harness).text, previousDefer(completedDefer(harness).path));
      assert.isFalse(harness.deferRemoved.includes(completedDefer(harness).path));
      assert.equal(harness.installRecords.size, 0); // Probe precedes even the canonical install record.
      assert.equal((yield* updates.getState).status, "downloaded");
      assert.include((yield* updates.getState).message ?? "", "storage is unavailable");
    })).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(TestClock.layer()))),
);

it.effect.each(["wrong-profile", "corrupt", "oversized", "unknown-scope"] as const)("refuses %s outcome storage without aliasing scope or installing", (failure) =>
  Effect.scoped(Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    const steps: string[] = [];
    const harness = makeHarness({ clientOnlyInventory: [], backendInstances: [ownedBackendFixture("primary", steps)],
      ...(failure === "wrong-profile" ? { env: { T3CODE_DESKTOP_PROFILE: "weasel" } } : failure === "unknown-scope" ? { env: { T3CODE_DESKTOP_PROFILE: "../invalid" } } : {}),
      deferRecord: failure === "corrupt" ? "{" : failure === "oversized" ? "x".repeat(16_385) : previousDefer,
      runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
    });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      if (failure === "unknown-scope") yield* updates.installPrepared("1.2.4");
      else { yield* TestClock.adjust(Duration.seconds(45)); yield* Deferred.await(released); }
      assert.equal(harness.quitAndInstalls(), 0);
      assert.isFalse(steps.some((step) => step.startsWith("stop:")));
      assert.include((yield* updates.getState).message ?? "", "storage is unavailable");
      if (failure === "unknown-scope") assert.equal(harness.deferFiles.size, 0);
    })).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(TestClock.layer()))),
);

it.effect.each(["32-valid", "33-peers", "UTF8-envelope"] as const)("checks the actual completed-envelope capacity before stops: %s", (boundary) =>
  Effect.scoped(Effect.gen(function* () {
    const steps: string[] = [];
    const released = yield* Deferred.make<void>();
    const installed = yield* Deferred.make<void>();
    const count = boundary === "33-peers" ? 33 : 32;
    const instances = Array.from({ length: count }, (_, index) => ownedBackendFixture(
      boundary === "UTF8-envelope" ? `${index}${'"'.repeat(250)}` : `owned-${index}`, steps));
    const harness = makeHarness({ clientOnlyInventory: [], backendInstances: instances,
      quitAndInstall: Deferred.succeed(installed, undefined).pipe(Effect.asVoid),
      runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid) });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      if (boundary === "32-valid") {
        yield* Deferred.await(installed);
        assert.equal(harness.quitAndInstalls(), 1);
        assert.equal(steps.filter((step) => step.startsWith("stop:")).length, 32);
      } else {
        yield* Deferred.await(released);
        assert.equal(harness.quitAndInstalls(), 0);
        assert.isFalse(steps.some((step) => step.startsWith("stop:")));
        assert.equal(harness.installRecords.size, 0);
      }
    })).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(TestClock.layer()))),
);

it.effect("reports actual stopped/unconfirmed peers when recovery-held storage fails AFTER partial shutdown", () =>
  Effect.scoped(Effect.gen(function* () {
    const steps: string[] = [];
    let storageFailed = false;
    const harness = makeHarness({ clientOnlyInventory: [], backendInstances: [
      ownedBackendFixture("stopped-peer", steps, { stop: Effect.sync(() => { storageFailed = true; return true; }) }),
      ownedBackendFixture("held-peer", steps, { stop: Effect.succeed(false), recoveryStatus: "held" }),
    ], beforeDeferWrite: Effect.suspend(() => storageFailed
      ? Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "write" })) : Effect.void) });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* TestClock.adjust(Duration.seconds(15));
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      yield* TestClock.adjust(Duration.seconds(45));
      yield* awaitUpdateState(updates, (state) => state.errorContext === "install");
      const state = yield* updates.getState;
      assert.equal(harness.quitAndInstalls(), 0);
      assert.isTrue(steps.includes("stop:stopped-peer"));
      assert.isTrue(steps.includes("stop:held-peer"));
      assert.isFalse(steps.some((step) => step.startsWith("abort:")));
      assert.include(state.message ?? "", "storage is unavailable after shutdown admission");
      assert.include(state.message ?? "", "stopped-peer=stopped");
      assert.include(state.message ?? "", "held-peer=unconfirmed");
      assert.notInclude(state.message ?? "", "zero stops");
    })).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(TestClock.layer()))),
);

it.effect("a newer captured attempt supersedes an old delayed refusal without replay or late overwrite", () =>
  Effect.scoped(Effect.gen(function* () {
    const lane = yield* Semaphore.make(1);
    const commitStarted = yield* Deferred.make<void>();
    const finishCommit = yield* Deferred.make<void>();
    const steps: string[] = [];
    let prepares = 0;
    const original = ownedBackendFixture("owned", steps, { commit: Deferred.succeed(commitStarted, undefined).pipe(Effect.andThen(Deferred.await(finishCommit)), Effect.as(false)) });
    const harness = makeHarness({ clientOnlyInventory: [], inventoryLane: (effect) => lane.withPermits(1)(effect), backendInstances: [{ ...original,
      prepareUpdate: (request) => ++prepares === 1 ? original.prepareUpdate!(request) : Effect.succeedNone,
    }] });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      const older = yield* updates.installPrepared("1.2.4").pipe(Effect.forkScoped);
      yield* Deferred.await(commitStarted);
      harness.emit("update-available", { version: "1.2.5" });
      yield* awaitUpdateState(updates, (state) => state.availableVersion === "1.2.5");
      harness.emit("update-downloaded", { version: "1.2.5" });
      yield* awaitUpdateState(updates, (state) => state.downloadedVersion === "1.2.5");
      const newer = yield* updates.installPrepared("1.2.5").pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(finishCommit, undefined);
      yield* Fiber.join(newer);
      yield* Fiber.join(older); // Consuming the older completion late must not change history.
      const record = completedDefer(harness);
      assert.equal(record.record.targetVersion, "1.2.5");
      assert.equal(prepares, 2);
      assert.equal(harness.quitAndInstalls(), 0);
      assert.isFalse(steps.some((step) => step.startsWith("stop:")));
      assert.equal(harness.deferRenames.filter(({ to }) => to === record.path).length, 1);
      assert.isFalse(harness.deferRemoved.includes(record.path));
    })).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(TestClock.layer()))),
);

it.effect("isolates actual SDK origins and development while the legitimate absent-profile scope remains stable", () =>
  Effect.gen(function* () {
    const files = new Map<string, string>();
    const save = (options: Parameters<typeof makeHarness>[0]) => Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const harness = makeHarness({ ...options, deferFiles: files, clientOnlyInventory: [], clientOnlyInstallQualified: false,
        runtimeReservationReleased: Deferred.succeed(released, undefined).pipe(Effect.asVoid) });
      yield* Effect.scoped(Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* awaitUpdateState(updates, (state) => state.downloadedVersion === "1.2.4");
        yield* updates.installPrepared("1.2.4");
        yield* Deferred.await(released);
        assert.equal(harness.quitAndInstalls(), 0);
        assert.equal(harness.stopCount(), 0);
      })).pipe(Effect.provide(harness.layer));
      return harness;
    });
    const first = yield* save({ homeDirectory: "/sdk-origin-a" });
    const initial = completedDefer(first);
    assert.isNull(JSON.parse(initial.text).profile);
    assert.match(initial.record.profileKey, /^[a-f0-9]{64}$/);
    assert.notInclude(initial.text, "/sdk-origin-a");
    yield* save({ homeDirectory: "/sdk-origin-a" });
    assert.equal(files.size, 1); // Fresh SDK, same legitimate absent default, same filename.
    assert.equal(files.get(initial.path), initial.text); // Unchanged meaning is not rewritten.
    yield* save({ homeDirectory: "/sdk-origin-b" });
    assert.equal(files.size, 2); // Same T3 home, different actual SDK appDataDirectory.
    yield* save({ homeDirectory: "/sdk-origin-a", env: { VITE_DEV_SERVER_URL: "http://localhost:5173" } });
    assert.equal(files.size, 3);
    for (const text of files.values()) {
      assert.isNull(JSON.parse(text).profile);
      assert.notInclude(text, "appDataDirectory");
      assert.notInclude(text, "/sdk-origin-");
    }
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect.each(["profile", "development", "appData", "filename-digest"] as const)("refuses %s scope disagreement before install or metadata publication", (mismatch) =>
  Effect.scoped(Effect.gen(function* () {
    const steps: string[] = [];
    const harness = makeHarness({ clientOnlyInventory: [], backendInstances: [ownedBackendFixture("owned", steps)],
      platform: mismatch === "appData" ? "win32" : "darwin",
      ...(mismatch === "appData" ? { env: { APPDATA: "C:\\actual-sdk-appdata" } } : {}),
      ...(mismatch === "profile" ? { environmentProfileOverride: Option.some("unexpected-profile") } : {}),
      ...(mismatch === "development" ? { environmentDevelopmentOverride: true } : {}),
      ...(mismatch === "appData" ? { environmentAppDataOverride: "C:\\different-sdk-appdata" } : {}),
      ...(mismatch === "filename-digest" ? { deferRecord: (path: string) => {
        const record = JSON.parse(previousDefer(path));
        record.profileKey = "0".repeat(64);
        return JSON.stringify(record);
      } } : {}),
    });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* awaitUpdateState(updates, (state) => state.downloadedVersion === "1.2.4");
      yield* updates.installPrepared("1.2.4");
      assert.equal(harness.quitAndInstalls(), 0);
      assert.isFalse(steps.some((step) => step.startsWith("stop:")));
      assert.equal(harness.deferRenames.length, 0);
      assert.equal(harness.installRecords.size, 0);
      if (mismatch !== "filename-digest") assert.equal(harness.deferFiles.size, 0);
      assert.include((yield* updates.getState).message ?? "", "storage is unavailable");
    })).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(TestClock.layer()))),
);

it.effect("persists partial-shutdown recovery-held peer identities across a fresh service without replay", () =>
  Effect.gen(function* () {
    const files = new Map<string, string>();
    const steps: string[] = [];
    const first = makeHarness({ deferFiles: files, clientOnlyInventory: [], backendInstances: [
      ownedBackendFixture("stopped-peer", steps),
      ownedBackendFixture("surviving-peer", steps, { stop: Effect.succeed(false), recoveryStatus: "held" }),
    ] });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      first.emit("update-downloaded", { version: "1.2.4" });
      yield* awaitUpdateState(updates, (state) => state.downloadedVersion === "1.2.4");
      yield* updates.installPrepared("1.2.4");
      const record = completedDefer(first).record;
      assert.equal(record.phase, "recovery-held");
      assert.equal(record.stopState, "may-have-started");
      assert.deepEqual(record.peers.map((peer) => [peer.instanceId, peer.shutdown, peer.status]), [
        ["stopped-peer", "stopped", "ready"], ["surviving-peer", "unconfirmed", "held"],
      ]);
      assert.equal(first.quitAndInstalls(), 0);
      assert.isFalse(steps.some((step) => step.startsWith("abort:")));
    })).pipe(Effect.provide(first.layer));
    const second = makeHarness({ deferFiles: files, omitInstallQualification: true });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      const state = yield* updates.getState;
      assert.include(state.message ?? "", "surviving-peer=unconfirmed/held");
      assert.include(state.message ?? "", "stopped-peer=stopped/ready");
      assert.isNull(state.downloadedVersion);
      assert.equal(second.quitAndInstalls(), 0);
      assert.equal(second.stopCount(), 0);
      assert.equal(second.checkCount(), 0);
    })).pipe(Effect.provide(second.layer));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("reports unavailable after published readback corruption without claiming the old record survived", () =>
  Effect.scoped(Effect.gen(function* () {
    const harness = makeHarness({ clientOnlyInventory: [], clientOnlyInstallQualified: false, deferRecord: previousDefer,
      transformDeferRead: (path, text) => !path.includes(`.${DesktopUpdates.DESKTOP_UPDATE_DEFER_RECORD_PREFIX}`) && text.includes('"runtime-unknown"') ? text + "corrupt" : text,
    });
    yield* Effect.scoped(Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* awaitUpdateState(updates, (state) => state.downloadedVersion === "1.2.4");
      yield* updates.installPrepared("1.2.4");
      const published = completedDefer(harness);
      assert.notEqual(published.text, previousDefer(published.path));
      assert.equal(harness.deferRenames.filter(({ to }) => to === published.path).length, 1);
      assert.isFalse(harness.deferRemoved.includes(published.path));
      assert.include((yield* updates.getState).message ?? "", "storage is unavailable");
      assert.equal(harness.quitAndInstalls(), 0);
      assert.equal(harness.stopCount(), 0);
    })).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(TestClock.layer()))),
);
