import { describe, expect, it } from "vitest";
import { CodexRealtimeLease } from "./codexRealtimeLease.ts";

const identity = {
  environmentId: "env-1",
  threadId: "thread-1",
  providerInstanceId: "codex-1",
  providerSessionId: "session-1",
  runtimeGeneration: 3,
  nativeThreadId: "native-thread-1",
  accountGeneration: 2,
  realtimeSessionId: "live-1",
  generation: 4,
} as const;

const finalResult = {
  runId: "run-1",
  attemptId: "attempt-1",
  finalMessageId: "message-1",
  sessionGeneration: 4,
} as const;

describe("CodexRealtimeLease", () => {
  it("requires complete runtime, account, native thread and session identity", () => {
    const lease = new CodexRealtimeLease(identity);
    expect(lease.owns(identity)).toBe(true);
    expect(lease.owns({ ...identity, accountGeneration: 1 })).toBe(false);
    expect(lease.owns({ ...identity, runtimeGeneration: 2 })).toBe(false);
    expect(lease.owns({ ...identity, nativeThreadId: "other" })).toBe(false);
    expect(lease.owns({ ...identity, generation: 5 })).toBe(false);
    lease.close();
    expect(lease.owns(identity)).toBe(false);
  });

  it("records one final readback and never retries an ambiguous append", () => {
    const lease = new CodexRealtimeLease(identity);
    expect(lease.beginReadback(finalResult)).toBe(true);
    expect(lease.beginReadback(finalResult)).toBe(false);
    expect(lease.settleReadback(finalResult, "unknown")).toBe(true);
    expect(lease.readbackState(finalResult)).toBe("unknown");
    expect(lease.beginReadback(finalResult)).toBe(false);
    expect(lease.settleReadback(finalResult, "sent")).toBe(false);
  });

  it("rejects stale-session results before they can be appended", () => {
    const lease = new CodexRealtimeLease(identity);
    expect(lease.beginReadback({ ...finalResult, sessionGeneration: 3 })).toBe(false);
  });
});
