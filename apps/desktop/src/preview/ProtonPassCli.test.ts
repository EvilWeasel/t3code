import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";
import {
  makeProtonPassProvider,
  ProtonPassUnavailable,
  runProtonPassEffect,
} from "./ProtonPassCli.ts";

it("lists metadata only and resolves just the explicitly selected item's two fields", async () => {
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === "--version") return "Proton Pass CLI 2.4.2 (fixture)\n";
    if (args[0] === "vault")
      return JSON.stringify({ vaults: [{ share_id: "v", name: "Personal" }] });
    if (args[1] === "list")
      return JSON.stringify({
        items: [
          {
            id: "i",
            share_id: "v",
            title: "Site",
            item_type: "login",
            password: "never-project-this",
          },
          { id: "other", share_id: "other-vault", title: "Other", item_type: "login" },
        ],
      });
    return args.at(-1) === "username" ? "fake-user\n" : "fake-password\n\n";
  });
  const provider = makeProtonPassProvider(run);
  expect(await provider.vaults()).toEqual([{ shareId: "v", title: "Personal" }]);
  const [selected] = await provider.logins("v");
  expect(selected).toEqual({ shareId: "v", itemId: "i", title: "Site" });
  expect(run.mock.calls.some(([args]) => args[1] === "view")).toBe(false);
  expect(await provider.credentials(selected!)).toEqual({
    username: "fake-user",
    password: "fake-password\n",
  });
  expect(run.mock.calls.filter(([args]) => args[1] === "view").map(([args]) => args)).toEqual([
    ["item", "view", "--share-id", "v", "--item-id", "i", "--field", "username"],
    ["item", "view", "--share-id", "v", "--item-id", "i", "--field", "password"],
  ]);
  expect(run.mock.calls.flatMap(([args]) => args)).not.toContain("--show-secrets");
});
it("refuses an unqualified CLI version before any metadata or secret request", async () => {
  const run = vi.fn(async () => "Proton Pass CLI 1.0.0\n");
  await expect(makeProtonPassProvider(run).vaults()).rejects.toMatchObject({
    state: "unsupported",
  });
  expect(run).toHaveBeenCalledOnce();
});
it("rejects unexpected metadata without echoing the private response", async () => {
  const run = vi.fn(async (args: readonly string[]) =>
    args[0] === "--version" ? "Proton Pass CLI 2.4.2" : "private-upstream-data",
  );
  await expect(makeProtonPassProvider(run).vaults()).rejects.toBeInstanceOf(ProtonPassUnavailable);
  await expect(makeProtonPassProvider(run).vaults()).rejects.not.toThrow("private-upstream-data");
});

// Fake process transport only; tests exercise the production scope, output bounds and timeout.
const fixtureSpawner = (options: {
  stdout: Stream.Stream<Uint8Array>;
  stderr: Stream.Stream<Uint8Array>;
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>;
  started: Effect.Effect<void>;
  stopped: Effect.Effect<void>;
}) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") throw new Error("Expected direct CLI command");
      expect(command.options).toMatchObject({
        shell: false,
        stdin: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: "1 second",
      });
      yield* Effect.addFinalizer(() => options.stopped);
      yield* options.started;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        stdout: options.stdout,
        stderr: options.stderr,
        all: Stream.empty,
        exitCode: options.exitCode,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );

effectIt.effect("times out after 15 seconds and finalizes only its captured CLI transport", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let stopped = 0;
    const spawner = fixtureSpawner({
      stdout: Stream.never,
      stderr: Stream.never,
      exitCode: Effect.never,
      started: Deferred.succeed(started, undefined).pipe(Effect.asVoid),
      stopped: Effect.sync(() => {
        stopped += 1;
      }),
    });
    const running = yield* runProtonPassEffect(["--version"]).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.result,
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("14 seconds");
    expect(running.pollUnsafe()).toBeUndefined();
    expect(stopped).toBe(0);
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(running);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.state).toBe("unavailable");
    expect(stopped).toBe(1);
  }).pipe(Effect.scoped),
);

effectIt.effect("rejects excessive private output and finalizes transport without echoing it", () =>
  Effect.gen(function* () {
    let stopped = 0;
    const spawner = fixtureSpawner({
      stdout: Stream.make(new TextEncoder().encode("private-output-".repeat(100000))),
      stderr: Stream.empty,
      exitCode: Effect.never,
      started: Effect.void,
      stopped: Effect.sync(() => {
        stopped += 1;
      }),
    });
    const result = yield* runProtonPassEffect(["item", "view"]).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.result,
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.state).toBe("unavailable");
      expect(result.failure.message).not.toContain("private-output");
    }
    expect(stopped).toBe(1);
  }),
);

for (const [upstream, state] of [
  ["locked", "locked"],
  ["not logged", "signed-out"],
] as const) {
  effectIt.effect(`keeps CLI ${state} failure static after process adapter redaction`, () =>
    Effect.gen(function* () {
      const spawner = fixtureSpawner({
        stdout: Stream.empty,
        stderr: Stream.make(new TextEncoder().encode(`private-upstream-data ${upstream}`)),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        started: Effect.void,
        stopped: Effect.void,
      });
      const result = yield* runProtonPassEffect(["vault", "list"]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.state).toBe(state);
        expect(result.failure.message).not.toContain("private-upstream-data");
      }
    }),
  );
}
