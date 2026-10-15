import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { LiveVoiceEvent, LiveVoiceSession } from "@t3tools/contracts";

import * as CodexLiveEventHub from "./CodexLiveEventHub.ts";

const session = {
  leaseId: "live-lease-1",
  generation: 1,
  environmentId: "env-1",
  threadId: "thread-1",
  providerInstanceId: "codex",
  providerSessionId: null,
  plannerNativeThreadId: null,
  status: "preparing",
} as LiveVoiceSession;

it.effect.each(["unknown", "stopping", "failed", "closed"] as const)(
  "orders %s transcript cutoff without cutting off another lease or newer generation",
  (status) =>
    Effect.gen(function* () {
      const hub = yield* CodexLiveEventHub.CodexLiveEventHub;
      const live = { ...session, status: "active" as const };
      const other = { ...live, leaseId: "other-live-lease" };
      const newer = { ...live, generation: 2 };
      const observe = (target: LiveVoiceSession) =>
        Effect.gen(function* () {
          yield* hub.register(target);
          const ready = yield* Deferred.make<void>();
          const collecting = yield* hub.subscribe(target).pipe(
            Stream.tap((event) =>
              event.type === "status" ? Deferred.succeed(ready, undefined) : Effect.void,
            ),
            Stream.takeUntil(
              (event) => event.type === "answer" && event.sdp === "delivery-barrier",
            ),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(ready);
          return collecting;
        });
      const liveEvents = yield* observe(live);
      const otherEvents = yield* observe(other);
      const newerEvents = yield* observe(newer);
      const transcript = (target: LiveVoiceSession, text: string) =>
        hub.publish({
          type: "transcript",
          leaseId: target.leaseId,
          generation: target.generation,
          role: "assistant",
          text,
        });
      yield* transcript(live, "Before the cutoff");
      yield* hub.publish({ type: "status", session: { ...live, status } });
      yield* transcript(live, "Obsolete transcript after the cutoff");
      yield* transcript(other, "The other conversation keeps talking");
      yield* transcript(newer, "The newer generation keeps talking");
      for (const target of [live, other, newer])
        yield* hub.publish({
          type: "answer",
          leaseId: target.leaseId,
          generation: target.generation,
          sdp: "delivery-barrier",
        });
      const observed = Array.from(yield* Fiber.join(liveEvents));
      assert.deepEqual(
        observed.map((event) => event.type),
        ["status", "transcript", "status", "answer"],
      );
      const texts = (events: ReadonlyArray<LiveVoiceEvent>) =>
        events.flatMap((event) => (event.type === "transcript" ? [event.text] : []));
      assert.deepEqual(texts(observed), ["Before the cutoff"]);
      assert.deepEqual(texts(Array.from(yield* Fiber.join(otherEvents))), [
        "The other conversation keeps talking",
      ]);
      assert.deepEqual(texts(Array.from(yield* Fiber.join(newerEvents))), [
        "The newer generation keeps talking",
      ]);
    }).pipe(Effect.provide(CodexLiveEventHub.layer)),
);

it.effect("starts each subscription with its correlated current status", () =>
  Effect.gen(function* () {
    const hub = yield* CodexLiveEventHub.CodexLiveEventHub;
    yield* hub.register(session);
    const first = yield* Stream.runHead(
      hub.subscribe({ leaseId: session.leaseId, generation: session.generation }),
    );
    assert.deepEqual(Option.getOrThrow(first), { type: "status", session });
  }).pipe(Effect.provide(CodexLiveEventHub.layer)),
);

it.effect("registers delivery before yielding the initial status barrier", () =>
  Effect.gen(function* () {
    const hub = yield* CodexLiveEventHub.CodexLiveEventHub;
    yield* hub.register(session);
    const events = yield* Stream.runCollect(
      hub.subscribe({ leaseId: session.leaseId, generation: session.generation }).pipe(
        Stream.tap((event) =>
          event.type === "status"
            ? hub.publish({
                type: "answer",
                leaseId: session.leaseId,
                generation: session.generation,
                sdp: "v=0",
              })
            : Effect.void,
        ),
        Stream.take(2),
      ),
    );
    assert.deepEqual(Array.from(events), [
      { type: "status", session },
      {
        type: "answer",
        leaseId: session.leaseId,
        generation: session.generation,
        sdp: "v=0",
      },
    ]);
  }).pipe(Effect.provide(CodexLiveEventHub.layer)),
);

it.effect("a stale status registration cannot replace a newer status snapshot", () =>
  Effect.gen(function* () {
    const hub = yield* CodexLiveEventHub.CodexLiveEventHub;
    const active = { ...session, status: "active" as const };
    yield* hub.register(session);
    yield* hub.publish({ type: "status", session: active });
    yield* hub.register(session);
    const first = yield* Stream.runHead(
      hub.subscribe({ leaseId: session.leaseId, generation: session.generation }),
    );
    assert.deepEqual(Option.getOrThrow(first), { type: "status", session: active });
  }).pipe(Effect.provide(CodexLiveEventHub.layer)),
);
