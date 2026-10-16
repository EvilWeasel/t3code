import { describe, expect, it } from "vite-plus/test";
import { AgentObservatoryOwner } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { createObservatoryAuthoredProjector } from "./authored.ts";
const owner = Schema.decodeUnknownSync(AgentObservatoryOwner)({
  environmentId: "one",
  threadId: "thread",
  runId: "run",
  attemptId: "attempt",
  rootNodeId: "root",
  providerInstanceId: "codex",
  providerThreadId: "native-thread",
  providerTurnId: "native-turn",
});
const state = {
  title: "Observe changes",
  steps: [{ id: "one", label: "Inspect", status: "active" }],
  todos: [],
  currentStepId: "one",
  requestedCheckpoint: { id: "review", label: "Review", when: "Before writes" },
  layout: "split",
  panels: [{ kind: "plan", collapsed: false }],
};
const read = (revision = 1, title = "Observe changes") => ({
  environmentId: owner.environmentId,
  threadId: owner.threadId,
  status: "online",
  throughSequence: 20,
  snapshot: {
    owner,
    revision,
    eventId: `event:${revision}`,
    sequence: revision + 1,
    recordedAt: DateTime.makeUnsafe("2026-10-16T00:00:00.000Z"),
    provenance: "agent-authored",
    nativeFrontier: { source: "observed-native", sequence: 1, rawEventId: null },
    state: { ...state, title },
  },
});
describe("canonical authored observatory reads", () => {
  it("applies live revisions while keeping requested checkpoint separate from exact reached proof", () => {
    const project = createObservatoryAuthoredProjector();
    const first = project(owner, read());
    expect(first.status === "ready" && first.checkpointReached).toBeNull();
    const second = project(owner, read(2, "Updated plan"));
    expect(second.status === "ready" && second.snapshot.state.title).toBe("Updated plan");
    expect(project(owner, read()).status).toBe("stale");
    const proof = {
      source: "canonical-event",
      owner,
      revision: 2,
      requestedCheckpointId: "review",
      eventId: "event:proof",
      sequence: 19,
    };
    const reached = project(owner, read(2, "Updated plan"), proof);
    expect(reached.status === "ready" && reached.checkpointReached).toBe(true);
    const foreign = project(owner, read(2, "Updated plan"), { ...proof, revision: 1 });
    expect(foreign.status === "ready" && foreign.checkpointReached).toBeNull();
    expect(project(owner, { ...read(2), throughSequence: 1 }).status).toBe("unavailable");
  });
  it("validates durable stale records independently of worker availability and advancing global frontier", () => {
    const project = createObservatoryAuthoredProjector();
    const bootstrap = { ...read(), status: "stale", throughSequence: 100 };
    const first = project(owner, bootstrap);
    expect(first).toMatchObject({
      status: "ready",
      recordStatus: "recorded",
      serviceStatus: "stale",
      checkpointReached: null,
    });
    // A global frontier can advance with no new authored event.
    expect(project(owner, { ...bootstrap, throughSequence: 110 })).toMatchObject({
      status: "ready",
    });
    expect(project(owner, { ...bootstrap, throughSequence: 109 }).status).toBe("stale");
    const updated = { ...read(2, "Committed update"), status: "stale", throughSequence: 120 };
    expect(project(owner, updated)).toMatchObject({
      status: "ready",
      recordStatus: "recorded",
      serviceStatus: "stale",
      snapshot: { revision: 2, sequence: 3, state: { title: "Committed update" } },
    });
    expect(project(owner, { ...updated, status: "online" })).toMatchObject({
      status: "ready",
      serviceStatus: "online",
      recordStatus: "recorded",
    });
    expect(
      project(owner, { ...updated, snapshot: { ...updated.snapshot, eventId: "different-event" } })
        .status,
    ).toBe("stale");
    expect(
      project(owner, { ...updated, snapshot: { ...updated.snapshot, sequence: 4 } }).status,
    ).toBe("stale");
    expect(
      project(owner, { ...updated, snapshot: { ...updated.snapshot, revision: 3 } }).status,
    ).toBe("stale");
    expect(
      project(owner, { ...updated, snapshot: { ...updated.snapshot, revision: 3, sequence: 4 } })
        .status,
    ).toBe("stale");
    expect(project(owner, bootstrap).status).toBe("stale");
    expect(project(owner, { ...updated, status: "offline" }).status).toBe("unavailable");
    expect(project(owner, { ...updated, status: "unsupported", snapshot: null }).status).toBe(
      "unsupported",
    );
    expect(
      project(owner, {
        ...updated,
        snapshot: { ...updated.snapshot, owner: { ...owner, attemptId: "foreign" } },
      }).status,
    ).toBe("unavailable");
  });
  it("refuses unknown feed, wrong scope/attempt, conflicting revision, offline and executable layout", () => {
    const project = createObservatoryAuthoredProjector();
    expect(project(owner, null).status).toBe("unsupported");
    expect(project(owner, read()).status).toBe("ready");
    expect(project(owner, read(1, "Conflict")).status).toBe("stale");
    expect(project(owner, { ...read(), environmentId: "other" }).status).toBe("unavailable");
    expect(project(owner, { ...read(), status: "offline" }).status).toBe("unavailable");
    expect(
      project(owner, {
        ...read(),
        snapshot: { ...read().snapshot, owner: { ...owner, attemptId: "other" } },
      }).status,
    ).toBe("unavailable");
    expect(
      project(owner, {
        ...read(),
        snapshot: {
          ...read().snapshot,
          state: { ...state, panels: [{ kind: "javascript", collapsed: false }] },
        },
      }).status,
    ).toBe("unavailable");
  });
});
