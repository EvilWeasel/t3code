import { describe, expect, it } from "vitest";
import { CodexRealtimeAdoption } from "./codexRealtimeAdoption.ts";

const lease = {
  environmentId: "env",
  threadId: "thread",
  providerInstanceId: "codex",
  providerSessionId: "provider-session",
  runtimeGeneration: 1,
  nativeThreadId: "native-thread",
  accountGeneration: 1,
  realtimeSessionId: "live-session",
  generation: 1,
} as const;

const ready = () => {
  const adoption = new CodexRealtimeAdoption(lease);
  adoption.setBaselineReady(true);
  adoption.setPolicyReady(true);
  return adoption;
};

describe("CodexRealtimeAdoption admission fixture", () => {
  it("does not admit before baseline and native policy are ready", () => {
    const adoption = new CodexRealtimeAdoption(lease);
    expect(adoption.observeNativeUserItem({ lease, nativeTurnId: "turn", nativeItemId: "item" })).toBeUndefined();
    adoption.setBaselineReady(true);
    expect(adoption.observeNativeUserItem({ lease, nativeTurnId: "turn", nativeItemId: "item" })).toBeUndefined();
  });

  it("adopts an idle native root once without creating a T3 dispatch", () => {
    const observation = ready().observeNativeUserItem({ lease, nativeTurnId: "turn", nativeItemId: "item" });
    expect(observation).toEqual({ kind: "adopt-root", nativeTurnId: "turn", nativeItemId: "item" });
  });

  it("deduplicates replayed notifications and rejects stale session identity", () => {
    const adoption = ready();
    const event = { lease, nativeTurnId: "turn", nativeItemId: "item" };
    expect(adoption.observeNativeUserItem(event)?.kind).toBe("adopt-root");
    expect(adoption.observeNativeUserItem(event)).toBeUndefined();
    expect(adoption.observeNativeUserItem({ ...event, lease: { ...lease, generation: 2 } })).toBeUndefined();
  });

  it("steers the currently adopted work and gates a competing typed start", () => {
    const adoption = ready();
    expect(adoption.observeNativeUserItem({ lease, nativeTurnId: "turn-1", nativeItemId: "item-1" })?.kind).toBe("adopt-root");
    adoption.setDurableActiveRun("run-1");
    const steer = adoption.observeNativeUserItem({ lease, nativeTurnId: "turn-2", nativeItemId: "item-2" });
    expect(steer).toEqual({ kind: "steer", nativeTurnId: "turn-2", nativeItemId: "item-2", runId: "run-1" });
    adoption.setTypedStartPending(true);
    expect(adoption.observeNativeUserItem({ lease, nativeTurnId: "turn-3", nativeItemId: "item-3" })).toBeUndefined();
  });

  it("does not release ownership for the wrong completion", () => {
    const adoption = ready();
    adoption.observeNativeUserItem({ lease, nativeTurnId: "turn-1", nativeItemId: "item-1" });
    adoption.setDurableActiveRun("run-1");
    adoption.completeRun("other");
    expect(adoption.observeNativeUserItem({ lease, nativeTurnId: "turn-2", nativeItemId: "item-2" })?.kind).toBe("steer");
  });
});
