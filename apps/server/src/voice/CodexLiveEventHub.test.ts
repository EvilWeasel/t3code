import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { LiveVoiceSession } from "@t3tools/contracts";

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
