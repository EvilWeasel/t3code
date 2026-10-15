import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";
import { createRendererUpdateReadiness, readRendererRuntimeReadiness } from "./desktopUpdateReadiness";

vi.mock("../composerDraftStore", () => ({ flushAndVerifyComposerDrafts: () => false }));

function state(phase: "prepare" | "validate" | "commit" = "prepare"): DesktopUpdateState {
  return {
    enabled: true, status: "downloaded", channel: "latest", currentVersion: "1.0.0",
    availableVersion: "1.0.1", downloadedVersion: "1.0.1", hostArch: "x64", appArch: "x64",
    runningUnderArm64Translation: false, releaseNotes: [], omittedReleaseCount: 0,
    downloadPercent: 100, checkedAt: null, message: null, errorContext: null, canRetry: true,
    installLease: { generation: "window-1", targetVersion: "1.0.1", expiresAt: Date.now() + 20_000, phase },
  };
}

describe("renderer update readiness", () => {
  const root = { inert: false };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    root.inert = false;
    vi.stubGlobal("document", {
      documentElement: root, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      querySelectorAll: () => [], querySelector: () => null,
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("leaves a recently active document usable without starting an unresolved runtime probe", async () => {
    const acknowledge = vi.fn(async () => true);
    const runtime = vi.fn(() => new Promise<"idle">(() => {}));
    const persist = vi.fn(() => true);
    const observer = createRendererUpdateReadiness({ acknowledgeUpdateReadiness: acknowledge }, runtime, persist);
    await observer.observe(state());
    expect(root.inert).toBe(false);
    expect(runtime).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ ready: false }));
    observer.dispose();
  });

  it.each(["busy", "unknown"] as const)("refuses %s runtime state without acknowledging persistence", async (runtimeState) => {
    const acknowledge = vi.fn(async () => true);
    const persist = vi.fn(() => true);
    const observer = createRendererUpdateReadiness({ acknowledgeUpdateReadiness: acknowledge }, async () => runtimeState, persist);
    vi.setSystemTime(60_001);
    await observer.observe(state());
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ ready: false }));
    expect(persist).not.toHaveBeenCalled();
    expect(root.inert).toBe(false);
    observer.dispose();
  });

  it("keeps input fenced after a committed verified draft flush until release", async () => {
    const acknowledge = vi.fn(async () => true);
    const persist = vi.fn(() => true);
    const observer = createRendererUpdateReadiness({ acknowledgeUpdateReadiness: acknowledge }, async () => "idle", persist);
    vi.setSystemTime(60_001);
    const prepared = state();
    await observer.observe(prepared);
    expect(acknowledge).toHaveBeenCalledWith({ lease: prepared.installLease, ready: true });
    expect(persist).toHaveBeenCalledOnce();
    await observer.observe({ ...prepared, installLease: { ...prepared.installLease!, phase: "commit" } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.inert).toBe(true);
    const { installLease: _lease, ...released } = prepared;
    await observer.observe(released);
    expect(root.inert).toBe(false);
    observer.dispose();
  });

  it("refuses an unpersisted draft and never acknowledges a disposed async probe", async () => {
    const acknowledge = vi.fn(async () => true);
    const observer = createRendererUpdateReadiness({ acknowledgeUpdateReadiness: acknowledge }, async () => "idle", () => false);
    vi.setSystemTime(60_001);
    await observer.observe(state());
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ ready: false }));
    observer.dispose();
    acknowledge.mockClear();
    let finish: ((value: "idle") => void) | undefined;
    const pending = createRendererUpdateReadiness({ acknowledgeUpdateReadiness: acknowledge }, () => new Promise((resolve) => { finish = resolve; }), () => true);
    vi.setSystemTime(120_002);
    const probe = pending.observe(state());
    pending.dispose();
    finish?.("idle");
    await probe;
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("does not equate granted microphone permission with an idle call", async () => {
    vi.stubGlobal("navigator", { permissions: { query: async () => ({ state: "granted" }) } });
    vi.stubGlobal("window", {});
    expect(await readRendererRuntimeReadiness()).toBe("unknown");
    vi.stubGlobal("navigator", {});
    expect(await readRendererRuntimeReadiness()).toBe("unknown");
  });
});
