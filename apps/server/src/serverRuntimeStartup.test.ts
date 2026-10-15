import * as Clock from "effect/Clock";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { RunId, type DesktopBackendUpdateResponse } from "@t3tools/contracts";
import * as Recovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    // Delegated recovery reads the runs recovery terminalizes, and settles them
    // before the worker runs restart continuations that would otherwise race it.
    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "recover",
      "delegated",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);

const updateContext = {
  environmentId: "env",
  bootId: "boot",
  requestId: "update",
  targetVersion: "25",
  admissionGeneration: 1,
  expiresAt: 20000,
};
const updateFixture = Effect.gen(function* () {
  const gate = yield* Recovery.makeBackendUpdateGate;
  const responses = yield* Queue.unbounded<DesktopBackendUpdateResponse>();
  let prepared = 0,
    cleared = 0,
    busy = false,
    valid = true,
    failClear = false,
    failPrepare = false;
  const coordinator = yield* ServerRuntimeStartup.makeBackendUpdateCoordinator({
    environmentId: "env",
    bootId: "boot",
    gate,
    prepare: Effect.suspend(() => {
      prepared++;
      return failPrepare
        ? Effect.fail("unsupported")
        : Effect.succeed({
            runIds: [RunId.make("source-run")],
            effectIds: ["effect:restart-continuation:source-run"],
          });
    }),
    validate: Effect.sync(() => valid),
    clear: Effect.suspend(() => {
      if (failClear) return Effect.fail("storage");
      cleared++;
      return Effect.void;
    }),
    busy: Effect.sync(() => busy),
    wake: Effect.void,
    send: (response) => Queue.offer(responses, response).pipe(Effect.asVoid),
    now: Clock.currentTimeMillis,
  });
  return {
    gate,
    responses,
    coordinator,
    counts: () => ({ prepared, cleared }),
    setBusy: (value: boolean) => {
      busy = value;
    },
    invalidate: () => {
      valid = false;
    },
    failCleanup: () => {
      failClear = true;
    },
    failPreparation: () => {
      failPrepare = true;
    },
  };
});
it.effect(
  "owned update preparation drains existing admission and rejects new work before durable proof",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* updateFixture;
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const active = yield* f.gate
          .run(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))))
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const prepare = yield* f.coordinator
          .request({ version: 1, type: "prepareBackendUpdate", context: updateContext })
          .pipe(Effect.forkChild);
        yield* f.gate.awaitHeld;
        assert.equal(f.counts().prepared, 0);
        let newWork = 0;
        yield* f.gate
          .run(
            Effect.sync(() => {
              newWork++;
            }),
          )
          .pipe(Effect.flip);
        assert.equal(newWork, 0);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(active);
        yield* Fiber.join(prepare);
        assert.deepEqual(yield* Queue.take(f.responses), {
          version: 1,
          type: "backendUpdatePrepared",
          context: updateContext,
          persistedRunIds: ["source-run"],
          reason: "ready",
        });
        yield* f.coordinator.request({
          version: 1,
          type: "abortBackendUpdate",
          context: updateContext,
        });
        assert.isFalse(f.gate.isHeld());
      }),
    ),
);
it.effect(
  "committed update ACK keeps gates through expiry and disconnect; explicit abort before shutdown is correlated and replayable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* updateFixture;
        yield* f.coordinator.request({
          version: 1,
          type: "prepareBackendUpdate",
          context: updateContext,
        });
        yield* Queue.take(f.responses);
        yield* f.coordinator.request({
          version: 1,
          type: "commitBackendUpdate",
          context: updateContext,
        });
        assert.equal((yield* Queue.take(f.responses)).type, "backendUpdateCommitted");
        yield* TestClock.adjust("30 seconds");
        yield* f.coordinator.disconnected;
        assert.isTrue(f.gate.isHeld());
        assert.equal(f.counts().cleared, 0);
        yield* f.coordinator.request({
          version: 1,
          type: "abortBackendUpdate",
          context: { ...updateContext, bootId: "old" },
        });
        assert.equal((yield* Queue.take(f.responses)).type, "backendUpdateRefused");
        assert.isTrue(f.gate.isHeld());
        yield* f.coordinator.request({
          version: 1,
          type: "abortBackendUpdate",
          context: updateContext,
        });
        assert.equal((yield* Queue.take(f.responses)).type, "backendUpdateAborted");
        assert.isFalse(f.gate.isHeld());
        yield* f.coordinator.request({
          version: 1,
          type: "abortBackendUpdate",
          context: updateContext,
        });
        assert.equal((yield* Queue.take(f.responses)).type, "backendUpdateAborted");
        assert.equal(f.counts().cleared, 1);
      }),
    ),
);
it.effect("once shutdown begins even matching committed abort cannot reopen admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* updateFixture;
      yield* f.coordinator.request({
        version: 1,
        type: "prepareBackendUpdate",
        context: updateContext,
      });
      yield* Queue.take(f.responses);
      yield* f.coordinator.request({
        version: 1,
        type: "commitBackendUpdate",
        context: updateContext,
      });
      yield* Queue.take(f.responses);
      f.coordinator.beginShutdown();
      yield* f.coordinator.request({
        version: 1,
        type: "abortBackendUpdate",
        context: updateContext,
      });
      assert.equal((yield* Queue.take(f.responses)).type, "backendUpdateRefused");
      assert.isTrue(f.gate.isHeld());
      assert.equal(f.counts().cleared, 0);
    }),
  ),
);
it.effect(
  "busy or strict persistence failure refuses before any stop and failed cleanup stays held",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* updateFixture;
        f.setBusy(true);
        yield* f.coordinator.request({
          version: 1,
          type: "prepareBackendUpdate",
          context: updateContext,
        });
        assert.match(JSON.stringify(yield* Queue.take(f.responses)), /busy/);
        assert.isFalse(f.gate.isHeld());
        assert.equal(f.counts().prepared, 0);
        const g = yield* updateFixture;
        g.failPreparation();
        g.failCleanup();
        yield* g.coordinator.request({
          version: 1,
          type: "prepareBackendUpdate",
          context: updateContext,
        });
        assert.match(JSON.stringify(yield* Queue.take(g.responses)), /persistence-failed/);
        assert.isTrue(g.gate.isHeld());
      }),
    ),
);
it.effect(
  "user control revision or changed validation refuses commit without reopening writers",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* updateFixture;
        yield* f.coordinator.request({
          version: 1,
          type: "prepareBackendUpdate",
          context: updateContext,
        });
        yield* Queue.take(f.responses);
        f.gate.noteControl();
        yield* f.coordinator.request({
          version: 1,
          type: "commitBackendUpdate",
          context: updateContext,
        });
        assert.equal((yield* Queue.take(f.responses)).type, "backendUpdateRefused");
        assert.isTrue(f.gate.isHeld());
        yield* f.coordinator.request({
          version: 1,
          type: "abortBackendUpdate",
          context: updateContext,
        });
        assert.equal((yield* Queue.take(f.responses)).type, "backendUpdateAborted");
      }),
    ),
);
it.effect(
  "uncommitted expiry clears only owned preparation then revokes and releases admission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* updateFixture;
        yield* f.coordinator.request({
          version: 1,
          type: "prepareBackendUpdate",
          context: updateContext,
        });
        yield* Queue.take(f.responses);
        yield* TestClock.adjust("21 seconds");
        assert.equal((yield* Queue.take(f.responses)).type, "backendUpdateRevoked");
        assert.isFalse(f.gate.isHeld());
        assert.equal(f.counts().cleared, 1);
      }),
    ),
);
