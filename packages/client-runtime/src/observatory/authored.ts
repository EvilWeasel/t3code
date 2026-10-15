import {
  AgentObservatoryCheckpointReached,
  AgentObservatoryOwner,
  AgentObservatoryRead,
  AgentObservatorySnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ObservatoryNativeDetails, ObservatoryNode } from "./native.ts";

const decodeRead = Schema.decodeUnknownSync(AgentObservatoryRead, { onExcessProperty: "error" });
const decodeReached = Schema.decodeUnknownSync(AgentObservatoryCheckpointReached, {
  onExcessProperty: "error",
});
const sameOwner = Schema.toEquivalence(AgentObservatoryOwner);
const sameSnapshot = Schema.toEquivalence(AgentObservatorySnapshot);
export type ObservatoryAuthored =
  | { readonly status: "unsupported" | "unavailable" | "stale" }
  | {
      readonly status: "ready";
      readonly snapshot: AgentObservatorySnapshot;
      readonly checkpointReached: boolean;
    };

/** Exact native correlation, not an owner claimed in agent-submitted layout data. */
export function observedObservatoryOwner(
  environmentId: EnvironmentId,
  node: ObservatoryNode,
  detail: ObservatoryNativeDetails,
): AgentObservatoryOwner | null {
  const run = detail.projection.runs.find((run) => run.id === node.runId);
  const attempt = detail.projection.attempts.find((attempt) => attempt.id === run?.activeAttemptId);
  const turn = detail.projection.providerTurns.find((turn) => turn.id === attempt?.providerTurnId);
  if (
    !run ||
    !attempt ||
    !turn ||
    run.rootNodeId === null ||
    run.rootNodeId !== attempt.rootNodeId ||
    attempt.runId !== run.id ||
    run.providerInstanceId !== attempt.providerInstanceId ||
    run.providerThreadId !== attempt.providerThreadId ||
    turn.providerThreadId !== attempt.providerThreadId ||
    turn.runAttemptId !== attempt.id
  )
    return null;
  return {
    environmentId,
    threadId: node.ref.threadId,
    runId: run.id,
    attemptId: attempt.id,
    rootNodeId: run.rootNodeId,
    providerInstanceId: attempt.providerInstanceId,
    providerThreadId: attempt.providerThreadId,
    providerTurnId: turn.id,
  };
}

/** A scoped, monotonic client view of the SAME canonical service's read. No writer/authority here. */
export function createObservatoryAuthoredProjector() {
  let latest: AgentObservatorySnapshot | null = null;
  return (
    owner: AgentObservatoryOwner | null,
    value: unknown,
    reached: unknown = null,
  ): ObservatoryAuthored => {
    if (value === null || value === undefined) {
      return { status: "unsupported" };
    }
    if (owner === null) {
      return { status: "unavailable" };
    }
    try {
      const read = decodeRead(value);
      const snapshot = read.snapshot;
      if (
        read.environmentId !== owner.environmentId ||
        read.threadId !== owner.threadId ||
        read.status !== "online" ||
        snapshot === null ||
        !sameOwner(owner, snapshot.owner) ||
        snapshot.sequence > read.throughSequence
      ) {
        return { status: read.status === "unsupported" ? "unsupported" : "unavailable" };
      }
      if (
        latest !== null &&
        sameOwner(owner, latest.owner) &&
        (snapshot.revision < latest.revision ||
          snapshot.sequence < latest.sequence ||
          (snapshot.revision === latest.revision && !sameSnapshot(snapshot, latest)))
      )
        return { status: "stale" };
      latest = snapshot;
      let checkpointReached = false;
      if (reached !== null && snapshot.state.requestedCheckpoint !== null) {
        const proof = decodeReached(reached);
        checkpointReached =
          sameOwner(proof.owner, owner) &&
          proof.revision === snapshot.revision &&
          proof.requestedCheckpointId === snapshot.state.requestedCheckpoint.id &&
          proof.sequence >= snapshot.sequence &&
          proof.sequence <= read.throughSequence;
      }
      return { status: "ready", snapshot, checkpointReached };
    } catch {
      return { status: "unavailable" };
    }
  };
}
