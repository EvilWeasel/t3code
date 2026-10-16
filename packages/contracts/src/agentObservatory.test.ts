import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  AgentObservatoryCheckpointReached,
  AgentObservatoryReadNativeRosterInput,
  AgentObservatorySubscribeNativeRosterInput,
  AgentObservatorySnapshot,
  AgentObservatoryUpdate,
  AgentObservatoryVisualState,
} from "./agentObservatory.ts";

const state = {
  title: "Inspect provider routing",
  steps: [{ id: "inspect", label: "Inspect actual route", status: "active" }],
  todos: [{ id: "proof", label: "Verify selected destination", status: "pending" }],
  currentStepId: "inspect",
  requestedCheckpoint: {
    id: "review",
    label: "Review before changing route",
    when: "Cause established",
  },
  layout: "split",
  panels: [
    { kind: "plan", collapsed: false },
    { kind: "approvals", collapsed: false },
  ],
};
const owner = {
  environmentId: "env:one",
  threadId: "thread:one",
  runId: "run:one",
  attemptId: "attempt:one",
  rootNodeId: "node:root",
  providerInstanceId: "codex",
  providerThreadId: "provider-thread:one",
  providerTurnId: "provider-turn:one",
};
const decode = Schema.decodeUnknownSync(AgentObservatoryVisualState);

describe("agent observatory declarative contract", () => {
  it("accepts bounded plan/todos/layout without treating a request as reached or paused", () => {
    const decoded = decode(state);
    expect(decoded.requestedCheckpoint?.id).toBe("review");
    expect(decoded).not.toHaveProperty("paused");
    expect(decoded).not.toHaveProperty("reached");
    expect(decoded).not.toHaveProperty("permission");
  });
  it.each([
    { currentStepId: "foreign" },
    { steps: [state.steps[0], state.steps[0]] },
    { todos: [state.todos[0], state.todos[0]] },
    { panels: [state.panels[0], state.panels[0]] },
    { title: "x".repeat(161) },
    { summary: "x".repeat(2049) },
    {
      steps: Array.from({ length: 41 }, (_, n) => ({
        id: `s${n}`,
        label: "Step",
        status: "pending",
      })),
    },
    { panels: [{ kind: "execute_script", collapsed: false }] },
  ])("refuses malformed, unbounded or executable layout %j", (invalid) => {
    expect(() => decode({ ...state, ...invalid })).toThrow();
  });
  it("separates update intent from host-authored owner, provenance and event frontier", () => {
    const input = Schema.decodeUnknownSync(AgentObservatoryUpdate)({
      requestId: "command:one",
      expectedRevision: 0,
      state,
    });
    expect(Object.keys(input).sort()).toEqual(["expectedRevision", "requestId", "state"]);
    expect(() =>
      Schema.decodeUnknownSync(AgentObservatoryUpdate)({ ...input, expectedRevision: -1 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AgentObservatorySnapshot)({
        owner,
        revision: 1,
        provenance: "observed-native",
        state,
      }),
    ).toThrow();
  });
  it("requires exact owner/revision/event proof for reached, distinct from requested", () => {
    const decodeReached = Schema.decodeUnknownSync(AgentObservatoryCheckpointReached);
    expect(() => decodeReached(state.requestedCheckpoint)).toThrow();
    const reached = decodeReached({
      source: "canonical-event",
      owner,
      revision: 2,
      requestedCheckpointId: "review",
      eventId: "event:reached",
      sequence: 19,
    });
    expect(reached.owner.attemptId).toBe("attempt:one");
    expect(reached.revision).toBe(2);
    expect(reached.eventId).toBe("event:reached");
  });
});

describe("agent observatory bounded roster read inputs", () => {
  it("rejects repeated selection, over-cap selection, invalid limits and unbound cursors", () => {
    const decode = Schema.decodeUnknownSync(AgentObservatoryReadNativeRosterInput);
    expect(decode({ threadIds: ["thread:a"], limit: 1 }).threadIds).toEqual(["thread:a"]);
    for (const input of [
      { threadIds: ["thread:a", "thread:a"], limit: 1 },
      { threadIds: Array.from({ length: 129 }, (_, i) => `thread:${i}`), limit: 1 },
      { threadIds: ["thread:a"], limit: 0 },
      { threadIds: ["thread:a"], limit: 201 },
      { threadIds: ["thread:a"], limit: 1, cursor: { throughSequence: 3, afterId: "node:a" } },
    ])
      expect(() => decode(input)).toThrow();
    const subscribe = Schema.decodeUnknownSync(AgentObservatorySubscribeNativeRosterInput)({
      threadIds: ["thread:a"],
      limit: 20,
      cursor: { afterId: "model-cursor" },
    });
    expect(subscribe).not.toHaveProperty("cursor");
  });
});
