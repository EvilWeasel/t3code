import {
  type EnvironmentId,
  type ThreadId,
  type RunId,
  type RunAttemptId,
  type NodeId,
  type ProviderInstanceId,
  type ProviderThreadId,
  type ProviderTurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";

export class TrustedAppControlInvocationError extends Schema.TaggedError<TrustedAppControlInvocationError>()(
  "TrustedAppControlInvocationError",
  {
    reason: Schema.Literals(["unbound", "stale_owner", "invalid_owner", "unavailable"]),
  },
) {
  override get message() {
    return `App control invocation refused: ${this.reason}.`;
  }
}
export interface CapturedAppControlExecution {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId;
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
}
export interface AppControlOwnerIdentity {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderAdapter.ProviderAdapterV2SessionRuntime["providerSessionId"];
  readonly providerThreadId: ProviderThreadId;
  readonly authorTurnId: ProviderTurnId;
  readonly nativeTurnId: string;
  readonly runtimeIncarnation: string;
}
let issueOwner: (identity: AppControlOwnerIdentity) => TrustedAppControlOwner;
/** Host capability only. No Schema/JSON constructor and no authority in copied fields. */
export class TrustedAppControlOwner {
  private constructor(private readonly data: Readonly<AppControlOwnerIdentity>) {}
  get identity() {
    return this.data;
  }
  static {
    issueOwner = (identity) => new TrustedAppControlOwner(Object.freeze(identity));
  }
}
export class TrustedAppControlInvocation extends Context.Service<
  TrustedAppControlInvocation,
  {
    readonly capture: (
      execution: CapturedAppControlExecution,
      native: ProviderAdapter.ProviderAdapterV2NativeInvocation,
    ) => Effect.Effect<TrustedAppControlOwner, TrustedAppControlInvocationError>;
    readonly validate: (
      owner: TrustedAppControlOwner,
    ) => Effect.Effect<void, TrustedAppControlInvocationError>;
    readonly withValidatedOwner: <A, E, R>(
      owner: TrustedAppControlOwner,
      use: (identity: AppControlOwnerIdentity) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | TrustedAppControlInvocationError, R>;
  }
>()("t3/mcp/TrustedAppControlInvocation") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const owners = new WeakMap<
    TrustedAppControlOwner,
    {
      execution: CapturedAppControlExecution;
      native: ProviderAdapter.ProviderAdapterV2NativeInvocation;
    }
  >();
  const incarnations = new WeakMap<object, string>();
  const normalize = (error: unknown) =>
    Schema.is(TrustedAppControlInvocationError)(error)
      ? error
      : new TrustedAppControlInvocationError({ reason: "unavailable" });
  const checkUnderLock = (
    execution: CapturedAppControlExecution,
    native: ProviderAdapter.ProviderAdapterV2NativeInvocation,
  ) =>
    Effect.gen(function* () {
      if (
        [native.callId, native.nativeThreadId, native.nativeTurnId].some(
          (value) => !value.trim() || value.length > 512,
        )
      )
        return yield* new TrustedAppControlInvocationError({ reason: "unbound" });
      const read = () =>
        projections.getThreadRecords(execution.threadId, [
          "runs",
          "attempts",
          "providerThreads",
          "providerTurns",
        ]);
      // A native/runtime lookup can yield. Never return an owner based only on
      // the projection captured before that await (especially across rollover).
      yield* read();
      const runtime = yield* sessions.get(execution.runtime.providerSessionId);
      const projection = yield* read();
      const run = projection.runs.find((candidate) => candidate.id === execution.runId);
      const attempt = projection.attempts.find((candidate) => candidate.id === execution.attemptId);
      const thread = projection.providerThreads.find(
        (candidate) => candidate.id === execution.providerThreadId,
      );
      const turn = projection.providerTurns.find(
        (candidate) => candidate.id === native.providerTurnId,
      );
      if (
        projection.thread.deletedAt !== null ||
        projection.thread.archivedAt !== null ||
        projection.thread.providerInstanceId !== execution.providerInstanceId ||
        !run ||
        run.status !== "running" ||
        run.activeAttemptId !== execution.attemptId ||
        run.rootNodeId !== execution.rootNodeId ||
        run.providerThreadId !== execution.providerThreadId ||
        run.providerInstanceId !== execution.providerInstanceId ||
        projection.runs.some(
          (candidate) => candidate.ordinal > run.ordinal && candidate.status !== "queued",
        ) ||
        !attempt ||
        attempt.runId !== run.id ||
        attempt.status !== "running" ||
        attempt.rootNodeId !== execution.rootNodeId ||
        attempt.providerThreadId !== execution.providerThreadId ||
        attempt.providerInstanceId !== execution.providerInstanceId ||
        !thread ||
        thread.appThreadId !== execution.threadId ||
        thread.ownerNodeId !== null ||
        thread.status !== "active" ||
        thread.driver !== execution.runtime.driver ||
        execution.runtime.instanceId !== execution.providerInstanceId ||
        thread.providerSessionId !== execution.runtime.providerSessionId ||
        thread.providerInstanceId !== execution.providerInstanceId ||
        thread.nativeThreadRef?.strength !== "strong" ||
        thread.nativeThreadRef.driver !== execution.runtime.driver ||
        thread.nativeThreadRef.nativeId !== native.nativeThreadId ||
        !turn ||
        turn.runAttemptId !== execution.attemptId ||
        turn.nodeId !== execution.rootNodeId ||
        turn.providerThreadId !== execution.providerThreadId ||
        turn.status !== "running" ||
        turn.nativeTurnRef?.strength !== "strong" ||
        turn.nativeTurnRef.driver !== execution.runtime.driver ||
        turn.nativeTurnRef.nativeId !== native.nativeTurnId ||
        Option.isNone(runtime) ||
        runtime.value !== execution.runtime
      )
        return yield* new TrustedAppControlInvocationError({ reason: "stale_owner" });
    }).pipe(Effect.mapError(normalize));
  const check = (
    execution: CapturedAppControlExecution,
    native: ProviderAdapter.ProviderAdapterV2NativeInvocation,
  ) => executor.withLock(execution.threadId, checkUnderLock(execution, native));
  return TrustedAppControlInvocation.of({
    capture: (input, envelope) =>
      Effect.gen(function* () {
        const execution = Object.freeze({ ...input });
        const native = Object.freeze({ ...envelope });
        const environmentId = yield* environment.getEnvironmentId;
        let incarnation = incarnations.get(execution.runtime);
        if (incarnation === undefined) {
          const candidate = yield* crypto.randomUUIDv4;
          incarnation = incarnations.get(execution.runtime) ?? candidate;
          incarnations.set(execution.runtime, incarnation);
        }
        yield* check(execution, native);
        const owner = issueOwner({
          environmentId,
          threadId: execution.threadId,
          runId: execution.runId,
          attemptId: execution.attemptId,
          rootNodeId: execution.rootNodeId,
          providerInstanceId: execution.providerInstanceId,
          providerSessionId: execution.runtime.providerSessionId,
          providerThreadId: execution.providerThreadId,
          authorTurnId: native.providerTurnId,
          nativeTurnId: native.nativeTurnId,
          runtimeIncarnation: incarnation,
        });
        owners.set(owner, { execution, native });
        return owner;
      }).pipe(Effect.mapError(normalize)),
    withValidatedOwner: (owner, use) =>
      Effect.suspend(() => {
        const binding = owners.get(owner);
        if (!binding)
          return Effect.fail(new TrustedAppControlInvocationError({ reason: "invalid_owner" }));
        return executor.withLock(
          binding.execution.threadId,
          checkUnderLock(binding.execution, binding.native).pipe(
            Effect.andThen(() => use(owner.identity)),
          ),
        );
      }),
    validate: (owner) =>
      Effect.suspend(() => {
        const binding = owners.get(owner);
        return binding === undefined
          ? Effect.fail(new TrustedAppControlInvocationError({ reason: "invalid_owner" }))
          : check(binding.execution, binding.native);
      }),
  });
});
/** Capturing identity does not authorize an actor send or change provider policy. */
export const layer = Layer.effect(TrustedAppControlInvocation, make);
