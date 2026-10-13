import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { LiveVoiceEvent, LiveVoiceSession } from "@t3tools/contracts";

type LeaseKey = `${string}:${number}`;
const keyOf = (leaseId: string, generation: number): LeaseKey => `${leaseId}:${generation}`;

/** Ordered per-environment Live events. A stream's first item is its status barrier. */
export class CodexLiveEventHub extends Context.Service<
  CodexLiveEventHub,
  {
    readonly register: (session: LiveVoiceSession) => Effect.Effect<void>;
    readonly publish: (event: LiveVoiceEvent) => Effect.Effect<void>;
    readonly subscribe: (input: {
      readonly leaseId: string;
      readonly generation: number;
    }) => Stream.Stream<LiveVoiceEvent>;
  }
>()("t3/voice/CodexLiveEventHub") {}

export const make = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  const sessions = yield* Ref.make(new Map<LeaseKey, LiveVoiceSession>());
  const events = yield* PubSub.unbounded<LiveVoiceEvent>();

  const publish = (event: LiveVoiceEvent) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (event.type === "status") {
          yield* Ref.update(sessions, (current) => {
            const next = new Map(current);
            next.set(keyOf(event.session.leaseId, event.session.generation), event.session);
            return next;
          });
        }
        yield* PubSub.publish(events, event);
      }),
    );

  return CodexLiveEventHub.of({
    register: (session) =>
      lock.withPermits(1)(
        Ref.update(sessions, (current) => {
          const next = new Map(current);
          next.set(keyOf(session.leaseId, session.generation), session);
          return next;
        }),
      ),
    publish,
    subscribe: ({ leaseId, generation }) =>
      Stream.unwrap(
        lock.withPermits(1)(
          Effect.gen(function* () {
            // Install the queue before taking the snapshot. The same lock orders any
            // later publication after this initial event in the returned stream.
            const subscription = yield* PubSub.subscribe(events);
            const session = (yield* Ref.get(sessions)).get(keyOf(leaseId, generation));
            if (session === undefined) return Stream.empty;
            const initial: LiveVoiceEvent = { type: "status", session };
            return Stream.concat(
              Stream.succeed(initial),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((event) =>
                  event.type === "status"
                    ? event.session.leaseId === leaseId && event.session.generation === generation
                    : event.leaseId === leaseId && event.generation === generation,
                ),
              ),
            );
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(CodexLiveEventHub, make);
