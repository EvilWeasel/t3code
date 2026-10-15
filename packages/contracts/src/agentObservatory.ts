import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  EventId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProviderThreadId,
  ProviderTurnId,
  RawEventId,
  RunAttemptId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const LocalId = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(320));

/** Correlation recorded by the host, never authority supplied by a model. */
export const AgentObservatoryOwner = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: RunId,
  attemptId: RunAttemptId,
  rootNodeId: NodeId,
  providerInstanceId: ProviderInstanceId,
  providerThreadId: ProviderThreadId,
  providerTurnId: ProviderTurnId,
});
export type AgentObservatoryOwner = typeof AgentObservatoryOwner.Type;

const Step = Schema.Struct({
  id: LocalId,
  label: Label,
  status: Schema.Literals(["pending", "active", "completed", "blocked"]),
});
const Todo = Schema.Struct({
  id: LocalId,
  label: Label,
  status: Schema.Literals(["pending", "completed", "blocked"]),
});
export const AgentObservatoryPanelKind = Schema.Literals([
  "plan",
  "todos",
  "activity",
  "tools",
  "commands",
  "approvals",
  "checkpoint",
  "artifacts",
  "context",
]);
export type AgentObservatoryPanelKind = typeof AgentObservatoryPanelKind.Type;

/** Declarative data only: no HTML, script, CSS, URL, command or arbitrary component. */
const VisualStateShape = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
  steps: Schema.Array(Step).check(Schema.isMaxLength(40)),
  todos: Schema.Array(Todo).check(Schema.isMaxLength(40)),
  currentStepId: Schema.NullOr(LocalId),
  requestedCheckpoint: Schema.NullOr(
    Schema.Struct({
      id: LocalId,
      label: Label,
      when: Label,
    }),
  ),
  layout: Schema.Literals(["single", "split"]),
  panels: Schema.Array(
    Schema.Struct({
      kind: AgentObservatoryPanelKind,
      collapsed: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(9)),
});
export const AgentObservatoryVisualState = VisualStateShape.check(
  Schema.makeFilter(
    (state: typeof VisualStateShape.Type) => {
      const stepIds = new Set(state.steps.map((step) => step.id));
      return (
        stepIds.size === state.steps.length &&
        new Set(state.todos.map((todo) => todo.id)).size === state.todos.length &&
        new Set(state.panels.map((panel) => panel.kind)).size === state.panels.length &&
        (state.currentStepId === null || stepIds.has(state.currentStepId))
      );
    },
    {
      expected: "unique step/todo/panel IDs and a current step belonging to this state",
      toJsonSchema: () => [{}, true],
    },
  ),
);
export type AgentObservatoryVisualState = typeof AgentObservatoryVisualState.Type;

/** Both UI and agent use this intent; the server binds principal, owner and provenance. */
export const AgentObservatoryUpdate = Schema.Struct({
  requestId: CommandId.check(Schema.isMaxLength(256)),
  expectedRevision: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER - 1)),
  state: AgentObservatoryVisualState,
});
export type AgentObservatoryUpdate = typeof AgentObservatoryUpdate.Type;

/** Existing authorized native activity stays in its canonical projection/stream. */
export const AgentObservatoryNativeFrontier = Schema.Struct({
  source: Schema.Literal("observed-native"),
  sequence: NonNegativeInt,
  rawEventId: Schema.NullOr(RawEventId),
});
export type AgentObservatoryNativeFrontier = typeof AgentObservatoryNativeFrontier.Type;

export const AgentObservatorySnapshot = Schema.Struct({
  owner: AgentObservatoryOwner,
  revision: PositiveInt,
  provenance: Schema.Literals(["agent-authored", "user-authored"]),
  eventId: EventId,
  sequence: PositiveInt,
  recordedAt: Schema.DateTimeUtc,
  nativeFrontier: AgentObservatoryNativeFrontier,
  state: AgentObservatoryVisualState,
});
export type AgentObservatorySnapshot = typeof AgentObservatorySnapshot.Type;

/** Offline/stale may retain an explicitly labelled snapshot; unsupported never fabricates one. */
export const AgentObservatoryRead = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  status: Schema.Literals(["online", "offline", "stale", "unsupported"]),
  throughSequence: NonNegativeInt,
  snapshot: Schema.NullOr(AgentObservatorySnapshot),
});
export type AgentObservatoryRead = typeof AgentObservatoryRead.Type;

/** A requested checkpoint is not a reached checkpoint, an approval or a paused run. */
export const AgentObservatoryCheckpointReached = Schema.Struct({
  source: Schema.Literal("canonical-event"),
  owner: AgentObservatoryOwner,
  revision: PositiveInt,
  requestedCheckpointId: LocalId,
  eventId: EventId,
  sequence: PositiveInt,
});
export type AgentObservatoryCheckpointReached = typeof AgentObservatoryCheckpointReached.Type;

/** Persisted on one canonical message. Sequence comes from its committed event envelope. */
const { sequence: _sequence, ...MetadataFields } = AgentObservatorySnapshot.fields;
export const AgentObservatoryMetadata = Schema.Struct({
  ...MetadataFields,
  requestId: CommandId,
});
export type AgentObservatoryMetadata = typeof AgentObservatoryMetadata.Type;

export const AgentObservatoryIntent = Schema.Union([
  Schema.Struct({ action: Schema.Literal("read") }),
  Schema.Struct({ action: Schema.Literal("publish"), ...AgentObservatoryUpdate.fields }),
]);
export type AgentObservatoryIntent = typeof AgentObservatoryIntent.Type;
export const AgentObservatoryInvocationResult = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("read"),
    snapshot: Schema.NullOr(AgentObservatorySnapshot),
  }),
  Schema.Struct({
    action: Schema.Literal("publish"),
    snapshot: AgentObservatorySnapshot,
    replayed: Schema.Boolean,
  }),
]);
export type AgentObservatoryInvocationResult = typeof AgentObservatoryInvocationResult.Type;
