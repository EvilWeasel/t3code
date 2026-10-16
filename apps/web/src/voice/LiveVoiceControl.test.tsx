// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  LiveVoiceError,
  liveVoicePublicErrorMessage,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({
  prepare: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  status: vi.fn(),
}));
vi.mock("../state/liveVoice", () => ({
  liveVoiceEnvironment: {
    prepare: "prepare",
    start: "start",
    stop: "stop",
    status: "status",
    events: vi.fn(),
  },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (name: keyof typeof commands) => commands[name],
}));

import {
  deriveLiveVoiceProviderEntries,
  classifyLiveVoicePrepareFailure,
  advanceLiveVoiceDiagnosticModel,
  LiveVoiceControl,
  resolveLiveVoiceAvailability,
  resolveLiveVoiceConfigState,
  resolveLiveVoiceInstanceSettings,
  resolveLiveVoiceControlGate,
  createLiveVoiceDiagnosticProducer,
} from "./LiveVoiceControl";
import { TooltipProvider } from "~/components/ui/tooltip";
import { unwrapLiveVoiceCommand } from "./LiveVoiceCommands";
import type {
  MainRendererDiagnosticsRequest,
  MainRendererDiagnosticsResponse,
  MainRendererDiagnosticsInvalidation,
} from "@t3tools/contracts";
import { resolveComposerProviderSelection } from "../components/ChatView.logic";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";

const environmentA = EnvironmentId.make("voice-environment-a");
const environmentB = EnvironmentId.make("voice-environment-b");
const thread = ThreadId.make("voice-thread");
type AvailabilityInput = Parameters<typeof resolveLiveVoiceAvailability>[0];
const loaded: AvailabilityInput = {
  environmentId: environmentA,
  threadId: thread,
  providerInstanceId: "codex",
  catalogEnvironmentId: environmentA,
  configState: "ready",
  settingsKnown: true,
  canOperate: true,
  permissionState: "known",
  selectionCurrent: true,
  instanceRequested: true,
  provider: { driverKind: "codex", enabled: true, isAvailable: true },
  instanceConfigured: true,
  config: { setupMode: "managed" },
};

const nativeLoaded: AvailabilityInput = {
  ...loaded,
  provider: {
    ...loaded.provider!,
    snapshot: { auth: { status: "authenticated", type: "chatgpt" } },
  },
  config: { setupMode: "existing" },
};

let root: Root;
let container: HTMLDivElement;
const getUserMedia = vi.fn();
const peer = vi.fn();

beforeEach(() => {
  Reflect.deleteProperty(window, "desktopBridge");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("RTCPeerConnection", peer);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  for (const command of Object.values(commands)) command.mockReset();
  commands.prepare.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new LiveVoiceError({ code: "managed_account_required" }))),
  );
  peer.mockClear();
  getUserMedia.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(window, "desktopBridge");
  vi.unstubAllGlobals();
});

const localEnvironment = EnvironmentId.make("24efa85c-862c-4de4-9b5e-aaaa041e28a4");
const rootThread = ThreadId.make("7cd05d6b-5e09-4691-a664-0b56c6283f12");
const localInput: AvailabilityInput = {
  ...loaded,
  environmentId: localEnvironment,
  catalogEnvironmentId: localEnvironment,
  threadId: rootThread,
};

function diagnosticBridgeFixture() {
  let requestSequence = 0;
  let listener: ((request: MainRendererDiagnosticsRequest) => void) | null = null;
  const unsubscribe = vi.fn();
  const bridge = {
    onMainRendererDiagnosticsRequest: vi.fn(
      (callback: (request: MainRendererDiagnosticsRequest) => void) => {
        listener = callback;
        return unsubscribe;
      },
    ),
    respondMainRendererDiagnostics: vi
      .fn<(response: MainRendererDiagnosticsResponse) => Promise<boolean>>()
      .mockResolvedValue(true),
    invalidateMainRendererDiagnostics: vi
      .fn<(input: MainRendererDiagnosticsInvalidation) => Promise<boolean>>()
      .mockResolvedValue(true),
  };
  const request = (
    requestId = "request-1",
    expiresAtMs = 5_000,
  ): MainRendererDiagnosticsRequest => ({
    version: 1,
    requestSequence: ++requestSequence,
    requestId,
    requestNonce: `nonce-${requestId}`,
    target: {
      environmentId: "24efa85c-862c-4de4-9b5e-aaaa041e28a4",
      threadId: "7cd05d6b-5e09-4691-a664-0b56c6283f12",
      providerInstanceId: "codex",
    },
    mainSession: "main-session",
    windowId: 1,
    frameProcessId: 2,
    frameRoutingId: 3,
    navigationGeneration: 4,
    expiresAtMs,
  });
  return {
    bridge,
    unsubscribe,
    request,
    send(input: MainRendererDiagnosticsRequest) {
      listener?.(input);
    },
  };
}

describe("explicit main renderer diagnostic requests", () => {
  it("rejects raw request extras before pinning session or consuming sequence", () => {
    const fixture = diagnosticBridgeFixture();
    const producer = createLiveVoiceDiagnosticProducer(fixture.bridge, {
      nowMs: () => 1_000,
      scheduleExpiry: () => () => {},
    })!;
    producer.update(gateFor(localInput));
    producer.start();
    const valid = fixture.request("valid");
    fixture.send({
      ...valid,
      mainSession: "foreign",
      requestSequence: 100,
      ...{ rawSettings: "forbidden" },
    });
    fixture.send({
      ...valid,
      requestSequence: 100,
      target: { ...valid.target, ...{ rawSettings: "forbidden" } },
    });
    expect(fixture.bridge.respondMainRendererDiagnostics).not.toHaveBeenCalled();
    expect(fixture.bridge.invalidateMainRendererDiagnostics).not.toHaveBeenCalled();
    fixture.send(valid);
    expect(fixture.bridge.respondMainRendererDiagnostics).toHaveBeenCalledOnce();
    expect(fixture.bridge.respondMainRendererDiagnostics.mock.calls[0]![0].binding).toEqual(valid);
    producer.dispose();
  });

  it("pins only the first valid unexpired session and rejects foreign sessions without consuming their sequence", () => {
    const fixture = diagnosticBridgeFixture();
    const producer = createLiveVoiceDiagnosticProducer(fixture.bridge, {
      nowMs: () => 1_000,
      scheduleExpiry: () => () => {},
    })!;
    producer.update(gateFor(localInput));
    producer.start();
    fixture.send({ ...fixture.request("expired-foreign", 1_000), mainSession: "foreign" });
    const a = fixture.request("valid-a");
    fixture.send(a);
    fixture.send({ ...fixture.request("foreign-b"), mainSession: "foreign", requestSequence: 100 });
    expect(fixture.bridge.respondMainRendererDiagnostics).toHaveBeenCalledOnce();
    expect(fixture.bridge.invalidateMainRendererDiagnostics).not.toHaveBeenCalled();
    const b = fixture.request("valid-b");
    fixture.send(b);
    expect(fixture.bridge.respondMainRendererDiagnostics).toHaveBeenCalledTimes(2);
    expect(fixture.bridge.respondMainRendererDiagnostics.mock.calls[1]![0].binding).toEqual(b);
    expect(fixture.bridge.invalidateMainRendererDiagnostics).toHaveBeenCalledExactlyOnceWith({
      binding: a,
      rendererEpoch: 1,
      revision: 1,
    });
    producer.dispose();
    const next = createLiveVoiceDiagnosticProducer(fixture.bridge, {
      nowMs: () => 1_000,
      scheduleExpiry: () => () => {},
    })!;
    next.update(gateFor(localInput));
    next.start();
    fixture.send({
      ...fixture.request("fresh-producer"),
      mainSession: "foreign",
      requestSequence: 1,
    });
    expect(fixture.bridge.respondMainRendererDiagnostics).toHaveBeenCalledTimes(3);
    next.dispose();
    expectPassive();
  });

  it("does not resnapshot retired A or invalidate replacement B on a still-unexpired A replay", async () => {
    const fixture = diagnosticBridgeFixture();
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: fixture.bridge });
    await render(localInput);
    const expiresAtMs = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 4_000;
    const a = fixture.request("retired-a", expiresAtMs);
    const b = fixture.request("current-b", expiresAtMs);
    await act(async () => fixture.send(a));
    await act(async () => fixture.send(b));
    expect(fixture.bridge.respondMainRendererDiagnostics).toHaveBeenCalledTimes(2);
    expect(fixture.bridge.invalidateMainRendererDiagnostics).toHaveBeenCalledOnce();
    expect(fixture.bridge.invalidateMainRendererDiagnostics.mock.calls[0]![0].binding).toEqual(a);
    await act(async () => fixture.send(a));
    expect(fixture.bridge.respondMainRendererDiagnostics).toHaveBeenCalledTimes(2);
    expect(fixture.bridge.invalidateMainRendererDiagnostics).toHaveBeenCalledOnce();
    const bResponse = fixture.bridge.respondMainRendererDiagnostics.mock.calls[1]![0];
    expect(bResponse.binding).toEqual(b);
    await render({ ...localInput, canOperate: false });
    expect(fixture.bridge.invalidateMainRendererDiagnostics).toHaveBeenCalledTimes(2);
    expect(fixture.bridge.invalidateMainRendererDiagnostics.mock.calls[1]![0]).toEqual({
      binding: b,
      rendererEpoch: bResponse.rendererEpoch,
      revision: bResponse.revision,
    });
    expectPassive();
  });

  it.each([
    "onMainRendererDiagnosticsRequest",
    "respondMainRendererDiagnostics",
    "invalidateMainRendererDiagnostics",
  ] as const)("does not create a producer when %s is absent", (missing) => {
    const fixture = diagnosticBridgeFixture();
    const partial: NonNullable<Parameters<typeof createLiveVoiceDiagnosticProducer>[0]> = {
      ...fixture.bridge,
    };
    delete partial[missing];
    const producer = createLiveVoiceDiagnosticProducer(partial, {
      nowMs: () => 1_000,
      scheduleExpiry: vi.fn(),
    });
    expect(producer).toBeNull();
    expect(fixture.bridge.onMainRendererDiagnosticsRequest).not.toHaveBeenCalled();
    expect(fixture.bridge.respondMainRendererDiagnostics).not.toHaveBeenCalled();
    expectPassive();
  });

  it("returns the mounted control's current gate only on a valid explicit request and invalidates the original pair", async () => {
    const fixture = diagnosticBridgeFixture();
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: fixture.bridge });
    await render(localInput);
    expect(fixture.bridge.onMainRendererDiagnosticsRequest).toHaveBeenCalledOnce();
    expect(fixture.bridge.respondMainRendererDiagnostics).not.toHaveBeenCalled();
    expectPassive();
    const request = fixture.request(
      "mounted-1",
      DateTime.toEpochMillis(DateTime.nowUnsafe()) + 4_000,
    );
    await act(async () => fixture.send(request));
    const response = fixture.bridge.respondMainRendererDiagnostics.mock.calls[0]![0];
    expect(response.binding).toEqual(request);
    expect(response.result.status).toBe("ready");
    if (response.result.status !== "ready") throw new Error("Expected ready diagnostic");
    expect(response.result.gate.canStart).toBe(!startButton().disabled);
    expect(response.result.gate.reason).toBeNull();
    await render({ ...localInput, canOperate: false });
    expect(fixture.bridge.invalidateMainRendererDiagnostics).toHaveBeenCalledExactlyOnceWith({
      binding: request,
      rendererEpoch: response.rendererEpoch,
      revision: response.revision,
    });
    await act(async () => fixture.send(request));
    expect(fixture.bridge.respondMainRendererDiagnostics).toHaveBeenCalledOnce();
    const second = fixture.request(
      "mounted-2",
      DateTime.toEpochMillis(DateTime.nowUnsafe()) + 4_000,
    );
    await act(async () => fixture.send(second));
    const next = fixture.bridge.respondMainRendererDiagnostics.mock.calls[1]![0];
    expect(next.revision).toBeGreaterThan(response.revision);
    if (next.result.status !== "ready") throw new Error("Expected ready diagnostic");
    expect(next.result.gate.canStart).toBe(!startButton().disabled);
    expect(next.result.gate.reason).toBe(await startHint());
    expectPassive();
  });

  it("never sends a gate on target mismatch and invalidates on navigation and unmount", async () => {
    const fixture = diagnosticBridgeFixture();
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: fixture.bridge });
    await render(loaded);
    const mismatch = fixture.request(
      "mismatch",
      DateTime.toEpochMillis(DateTime.nowUnsafe()) + 4_000,
    );
    await act(async () => fixture.send(mismatch));
    expect(fixture.bridge.respondMainRendererDiagnostics.mock.calls[0]![0].result).toEqual({
      status: "unavailable",
      reason: "target-mismatch",
    });
    await render(localInput);
    expect(fixture.bridge.invalidateMainRendererDiagnostics).toHaveBeenCalledOnce();
    const current = fixture.request(
      "current",
      DateTime.toEpochMillis(DateTime.nowUnsafe()) + 4_000,
    );
    await act(async () => fixture.send(current));
    await act(async () => root.unmount());
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    const responses = fixture.bridge.respondMainRendererDiagnostics.mock.calls.length;
    fixture.send(fixture.request("after-unmount", current.expiresAtMs));
    expect(fixture.bridge.respondMainRendererDiagnostics).toHaveBeenCalledTimes(responses);
    expect(fixture.bridge.invalidateMainRendererDiagnostics.mock.calls.at(-1)?.[0].binding).toEqual(
      current,
    );
    expectPassive();
  });

  it("rejects malformed, expired, overlong and clock-rollback requests and only schedules expiry after a request", () => {
    const fixture = diagnosticBridgeFixture();
    let now = 1_000;
    const expiries = new Set<() => void>();
    const scheduleExpiry = vi.fn((callback: () => void, _delay: number) => {
      expiries.add(callback);
      return () => {
        expiries.delete(callback);
      };
    });
    const producer = createLiveVoiceDiagnosticProducer(fixture.bridge, {
      nowMs: () => now,
      scheduleExpiry,
    })!;
    producer.update(gateFor(localInput));
    producer.start();
    expect(scheduleExpiry).not.toHaveBeenCalled();
    fixture.send(fixture.request("bad request"));
    fixture.send(fixture.request("expired", now));
    fixture.send(fixture.request("too-long", now + 5_001));
    expect(fixture.bridge.respondMainRendererDiagnostics).not.toHaveBeenCalled();
    const request = fixture.request();
    fixture.send(request);
    fixture.send(request);
    expect(fixture.bridge.respondMainRendererDiagnostics).toHaveBeenCalledOnce();
    expect(scheduleExpiry).toHaveBeenCalledOnce();
    now = 5_001;
    for (const expire of [...expiries]) expire();
    fixture.send(request);
    now = 1_001;
    fixture.send(fixture.request("rollback", 4_000));
    expect(fixture.bridge.respondMainRendererDiagnostics).toHaveBeenCalledOnce();
    producer.dispose();
    expectPassive();
  });

  it("does not let a delayed rejected response invalidate a replacement request", async () => {
    const fixture = diagnosticBridgeFixture();
    let reject!: (cause: Error) => void;
    fixture.bridge.respondMainRendererDiagnostics.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const producer = createLiveVoiceDiagnosticProducer(fixture.bridge, {
      nowMs: () => 1_000,
      scheduleExpiry: () => () => {},
    })!;
    producer.update(gateFor(localInput));
    producer.start();
    fixture.send(fixture.request("old"));
    fixture.send(fixture.request("replacement"));
    expect(fixture.bridge.invalidateMainRendererDiagnostics).toHaveBeenCalledOnce();
    reject(new Error("private IPC failure"));
    await Promise.resolve();
    expect(fixture.bridge.invalidateMainRendererDiagnostics).toHaveBeenCalledOnce();
    producer.dispose();
    expect(
      fixture.bridge.invalidateMainRendererDiagnostics.mock.calls.at(-1)?.[0].binding.requestId,
    ).toBe("replacement");
    expectPassive();
  });

  it("reports an actually observed prepare code without running a provider for a diagnostic request", async () => {
    const fixture = diagnosticBridgeFixture();
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: fixture.bridge });
    await render(localInput);
    expectPassive();
    await act(async () => startButton().click());
    await act(async () =>
      fixture.send(
        fixture.request("after-prepare", DateTime.toEpochMillis(DateTime.nowUnsafe()) + 4_000),
      ),
    );
    const result = fixture.bridge.respondMainRendererDiagnostics.mock.calls[0]![0].result;
    if (result.status !== "ready") throw new Error("Expected ready diagnostic");
    expect(result.gate.prepareFailure).toBe("managed_account_required");
    expect(commands.prepare).toHaveBeenCalledOnce();
    expect(commands.start).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(peer).not.toHaveBeenCalled();
  });
});

async function render(input: AvailabilityInput, targetEnvironment = input.environmentId) {
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <LiveVoiceControl
          environmentId={targetEnvironment}
          threadId={input.threadId}
          providerInstanceId={input.providerInstanceId}
          eligible={true}
          availability={resolveLiveVoiceAvailability(input)}
        />
      </TooltipProvider>,
    ),
  );
}

function startButton() {
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Start voice call"]');
  if (!button) throw new Error("Missing Start voice call button");
  return button;
}

async function startHint() {
  const trigger = startButton().closest<HTMLElement>('[data-slot="tooltip-trigger"]');
  if (!trigger) throw new Error("Missing keyboard-accessible voice hint trigger");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    trigger.focus();
  });
  const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
  if (!tooltip) throw new Error("Voice hint did not open on deliberate focus");
  return tooltip.textContent;
}

function expectPassive() {
  expect(commands.prepare).not.toHaveBeenCalled();
  expect(commands.start).not.toHaveBeenCalled();
  expect(commands.status).not.toHaveBeenCalled();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(peer).not.toHaveBeenCalled();
}

function gateFor(
  input: AvailabilityInput,
  phase: Parameters<typeof resolveLiveVoiceControlGate>[0]["phase"] = "idle",
  prepareFailure: ReturnType<typeof classifyLiveVoicePrepareFailure> | null = null,
) {
  return resolveLiveVoiceControlGate({
    environmentId: input.environmentId,
    threadId: input.threadId,
    providerInstanceId: input.providerInstanceId,
    availability: resolveLiveVoiceAvailability(input),
    eligible: true,
    phase,
    RTCPeerConnection: peer,
    getUserMedia,
    prepareFailure,
  });
}

describe("Live voice diagnostic producer model (transport absent)", () => {
  it("uses the rendered gate unchanged and freezes only sanitized data", async () => {
    const input = { ...loaded, config: { setupMode: "managed", privateKey: "must-not-copy" } };
    const gate = gateFor(input);
    const model = advanceLiveVoiceDiagnosticModel(null, gate);
    await render(input);
    expect(model.gate).toBe(gate);
    expect(model.gate.canStart).toBe(!startButton().disabled);
    expect(model.gate.reason).toBeNull();
    expect(model.gate.facts).toMatchObject({ driver: "codex", setupMode: "managed" });
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.gate)).toBe(true);
    expect(Object.isFrozen(model.gate.facts)).toBe(true);
    expect(JSON.stringify(model)).not.toContain("privateKey");
    expect(JSON.stringify(model)).not.toContain("must-not-copy");
    expect(() => Object.assign(model.gate, { canStart: false })).toThrow(TypeError);
    expectPassive();
  });

  it("keeps stable revision for identical sanitized facts and increments on actual gate changes", async () => {
    const first = advanceLiveVoiceDiagnosticModel(null, gateFor(loaded));
    const unchanged = advanceLiveVoiceDiagnosticModel(
      first,
      gateFor({
        ...loaded,
        config: { setupMode: "managed", ignoredPrivateField: "not-observed" },
      }),
    );
    expect(unchanged).toBe(first);
    const denied = { ...loaded, canOperate: false };
    const next = advanceLiveVoiceDiagnosticModel(first, gateFor(denied));
    expect(next.epoch).toBe(first.epoch);
    expect(next.revision).toBe(first.revision + 1);
    await render(denied);
    expect(next.gate.canStart).toBe(!startButton().disabled);
    expect(await startHint()).toBe(next.gate.reason);
    expect(next.gate.facts?.canOperate).toBe(false);
    const busy = advanceLiveVoiceDiagnosticModel(first, gateFor(loaded, "preparing"));
    expect(busy.gate.canStart).toBe(false);
    expect(busy.gate.busy).toBe(true);
    expect(busy.revision).toBe(first.revision + 1);
    expectPassive();
  });

  it("advances context epoch on environment/thread/provider changes and never revives an old epoch", () => {
    const first = advanceLiveVoiceDiagnosticModel(null, gateFor(loaded));
    const b = advanceLiveVoiceDiagnosticModel(
      first,
      gateFor({
        ...loaded,
        environmentId: environmentB,
        catalogEnvironmentId: environmentB,
      }),
    );
    expect(b.epoch).toBe(first.epoch + 1);
    expect(b.revision).toBe(1);
    const back = advanceLiveVoiceDiagnosticModel(b, gateFor(loaded));
    expect(back.epoch).toBe(b.epoch + 1);
    const otherThread = advanceLiveVoiceDiagnosticModel(
      back,
      gateFor({
        ...loaded,
        threadId: ThreadId.make("other-thread"),
      }),
    );
    const otherProvider = advanceLiveVoiceDiagnosticModel(
      otherThread,
      gateFor({
        ...loaded,
        threadId: ThreadId.make("other-thread"),
        providerInstanceId: "codex-custom",
      }),
    );
    expect(otherThread.epoch).toBe(back.epoch + 1);
    expect(otherProvider.epoch).toBe(otherThread.epoch + 1);
    const staleGate = resolveLiveVoiceControlGate({
      environmentId: environmentB,
      threadId: thread,
      providerInstanceId: "codex",
      availability: resolveLiveVoiceAvailability(loaded),
      eligible: true,
      phase: "idle",
      RTCPeerConnection: peer,
      getUserMedia,
    });
    expect(staleGate.canStart).toBe(false);
    expect(staleGate.facts).toBeNull();
    expectPassive();
  });

  it("withholds stale catalog facts and keeps provider/config metadata enumerated", () => {
    const failed = gateFor({ ...loaded, configState: "failed" });
    expect(failed.facts).toMatchObject({
      driver: "unknown",
      setupMode: "unknown",
      providerEnabled: null,
      catalogState: "failed",
    });
    const pending = gateFor({ ...loaded, permissionState: "pending", canOperate: false });
    expect(pending.facts?.canOperate).toBeNull();
    const override = gateFor({
      ...loaded,
      projectOverride: false,
      provider: { ...loaded.provider!, enabled: false },
    });
    expect(override.facts).toMatchObject({ projectOverride: "disabled", providerEnabled: false });
    const unsupported = advanceLiveVoiceDiagnosticModel(
      null,
      gateFor({
        ...loaded,
        provider: { ...loaded.provider!, driverKind: "private-driver-name" },
        config: { setupMode: "private-invalid-mode" },
      }),
    );
    expect(unsupported.gate.facts).toMatchObject({ driver: "other", setupMode: "invalid" });
    expect(JSON.stringify(unsupported)).not.toContain("private-driver-name");
    expect(JSON.stringify(unsupported)).not.toContain("private-invalid-mode");
    expectPassive();
  });
});

describe("LiveVoice instance defaults", () => {
  const provider = {
    instanceId: ProviderInstanceId.make("codex"),
    driverKind: ProviderDriverKind.make("codex"),
  };

  function availabilityFor(
    selected: typeof provider,
    settings: Parameters<typeof resolveLiveVoiceInstanceSettings>[1],
    patch: Partial<AvailabilityInput> = {},
  ) {
    const instance = resolveLiveVoiceInstanceSettings(selected, settings);
    return {
      ...nativeLoaded,
      providerInstanceId: selected.instanceId,
      instanceConfigured: instance !== undefined,
      config: instance?.config,
      ...patch,
    };
  }

  it("uses the observed setup mode when checking browser support", () => {
    const availability = resolveLiveVoiceAvailability(nativeLoaded);
    for (const setupMode of ["missing", "invalid", "unknown"] as const) {
      const gate = resolveLiveVoiceControlGate({
        environmentId: environmentA,
        threadId: thread,
        providerInstanceId: "codex",
        availability: { ...availability, facts: { ...availability.facts, setupMode } },
        eligible: true,
        phase: "idle",
        RTCPeerConnection: peer,
        getUserMedia,
      });
      expect(gate.canStart).toBe(false);
    }
    expectPassive();
  });

  it("admits the implicit built-in Codex default without saving settings or probing", async () => {
    const settings = { providerInstances: {} };
    const input = availabilityFor(provider, settings);
    expect(gateFor(input).canStart).toBe(true);
    expect(gateFor(input).facts?.setupMode).toBe("existing");
    expect(settings.providerInstances).toEqual({});
    await render(input);
    expect(startButton().disabled).toBe(false);
    expectPassive();
    await act(async () => startButton().click());
    expect(commands.prepare).toHaveBeenCalledOnce();
    expect(commands.start).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(peer).not.toHaveBeenCalled();
  });

  it.each(
    [undefined, null, {}, { binaryPath: "custom-codex", homePath: "custom-home" }].map(
      (config) => ({ config }),
    ),
  )(
    "uses native defaults for omitted legacy config/mode while preserving fields: %j",
    ({ config }) => {
      const settings = {
        providerInstances: { [provider.instanceId]: { driver: provider.driverKind, config } },
      };
      const before = structuredClone(settings);
      const resolved = resolveLiveVoiceInstanceSettings(provider, settings);
      expect(resolved?.config).toEqual({ ...(config ?? {}), setupMode: "existing" });
      expect(settings).toEqual(before);
      expect(gateFor(availabilityFor(provider, settings)).canStart).toBe(true);
      expectPassive();
    },
  );

  it("requires an own configured entry for custom Codex instances", () => {
    const custom = { ...provider, instanceId: ProviderInstanceId.make("codex-personal") };
    const missing = availabilityFor(custom, { providerInstances: {} });
    expect(gateFor(missing).canStart).toBe(false);
    expect(gateFor(missing).reason).toContain("no saved settings");
    const configured = availabilityFor(custom, {
      providerInstances: { [custom.instanceId]: { driver: provider.driverKind, config: {} } },
    });
    expect(gateFor(configured).canStart).toBe(true);
    expect(
      resolveLiveVoiceInstanceSettings(
        { ...provider, driverKind: ProviderDriverKind.make("claudeAgent") },
        { providerInstances: {} },
      ),
    ).toBeUndefined();
    expect(resolveLiveVoiceInstanceSettings(provider, undefined)).toBeUndefined();
    expectPassive();
  });

  it.each(
    ["existing", [], { setupMode: null }, { setupMode: "invalid" }, { setupMode: undefined }].map(
      (config) => ({ config }),
    ),
  )("preserves malformed explicit config for rejection: %j", ({ config }) => {
    const settings = {
      providerInstances: { [provider.instanceId]: { driver: provider.driverKind, config } },
    };
    expect(resolveLiveVoiceInstanceSettings(provider, settings)?.config).toBe(config);
    expect(gateFor(availabilityFor(provider, settings)).canStart).toBe(false);
    expectPassive();
  });

  it.each([
    {
      provider: {
        ...nativeLoaded.provider!,
        snapshot: { auth: { status: "authenticated", type: "apiKey" } },
      },
    },
    {
      provider: {
        ...nativeLoaded.provider!,
        snapshot: { auth: { status: "unauthenticated", type: "chatgpt" } },
      },
    },
    { provider: { ...nativeLoaded.provider!, snapshot: { auth: { status: "authenticated" } } } },
    { provider: { ...nativeLoaded.provider!, snapshot: undefined } },
    { provider: { ...nativeLoaded.provider!, enabled: false } },
    { provider: { ...nativeLoaded.provider!, isAvailable: false } },
    { provider: { ...nativeLoaded.provider!, driverKind: "claudeAgent" } },
    { catalogEnvironmentId: environmentB },
    { settingsKnown: false },
    { permissionState: "pending" },
    { canOperate: false },
    { selectionCurrent: false },
    { configState: "failed" },
  ] satisfies ReadonlyArray<Partial<AvailabilityInput>>)(
    "keeps native defaults behind real auth, catalog and permission gates: %j",
    async (patch) => {
      const input = availabilityFor(provider, { providerInstances: {} }, patch);
      expect(gateFor(input).canStart).toBe(false);
      await render(input);
      expect(startButton().disabled).toBe(true);
      await act(async () => startButton().click());
      expectPassive();
    },
  );
});

describe("LiveVoiceControl passive availability", () => {
  it.each([
    "unsupported_provider",
    "managed_account_required",
    "session_not_found",
    "stale_lease",
    "planner_restriction_failed",
    "invalid_state",
    "dispatch_conflict",
    "runtime_unavailable",
  ] as const)(
    "classifies only observed typed prepare failure %s after deliberate start",
    async (code) => {
      const result = AsyncResult.failure(Cause.fail(new LiveVoiceError({ code })));
      let classified: ReturnType<typeof classifyLiveVoicePrepareFailure> | null = null;
      try {
        unwrapLiveVoiceCommand(result);
      } catch (error) {
        classified = classifyLiveVoicePrepareFailure(error);
      }
      expect(classified).toBe(code);
      commands.prepare.mockResolvedValue(result);
      await render(loaded);
      expectPassive();
      await act(async () => startButton().click());
      expect(container.textContent).toContain(liveVoicePublicErrorMessage(code));
      expect(commands.prepare).toHaveBeenCalledOnce();
      expect(commands.start).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(peer).not.toHaveBeenCalled();
      const model = advanceLiveVoiceDiagnosticModel(null, gateFor(loaded, "error", classified));
      expect(model.gate.prepareFailure).toBe(code);
    },
  );

  it("never infers a typed account failure from arbitrary text", () => {
    const raw = new Error(
      "private detail: " + liveVoicePublicErrorMessage("managed_account_required"),
    );
    expect(classifyLiveVoicePrepareFailure(raw)).toBe("unclassified");
    const model = advanceLiveVoiceDiagnosticModel(
      null,
      gateFor(loaded, "error", classifyLiveVoicePrepareFailure(raw)),
    );
    expect(JSON.stringify(model)).not.toContain("private detail");
    expect(model.gate.prepareFailure).toBe("unclassified");
    expectPassive();
  });

  it("ignores a late prepare failure from an aborted A context after A to B to A", async () => {
    let finish!: (result: ReturnType<typeof AsyncResult.failure>) => void;
    commands.prepare.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render(loaded);
    await act(async () => startButton().click());
    await render({ ...loaded, environmentId: environmentB, catalogEnvironmentId: environmentB });
    await render(loaded);
    await act(async () =>
      finish(
        AsyncResult.failure(Cause.fail(new LiveVoiceError({ code: "managed_account_required" }))),
      ),
    );
    expect(startButton().disabled).toBe(false);
    expect(container.textContent).not.toContain("Sign in");
    expect(commands.prepare).toHaveBeenCalledOnce();
    expect(commands.start).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(peer).not.toHaveBeenCalled();
  });

  it("keeps the production voice fallback identical to the composer for a stale request and custom-first wire order", async () => {
    const driver = ProviderDriverKind.make("codex");
    const provider = (id: string): ServerProvider => ({
      driver,
      instanceId: ProviderInstanceId.make(id),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      version: null,
      checkedAt: "2026-10-15T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    });
    const providers = [provider("codex-custom"), provider("codex")];
    const settings = {
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver,
          enabled: true,
          config: { setupMode: "managed" },
        },
        [ProviderInstanceId.make("codex-custom")]: {
          driver,
          enabled: true,
          config: { setupMode: "managed" },
        },
      },
      projectSettingsOverrides: {},
    };
    const selectionInput = {
      candidateInstanceIds: [ProviderInstanceId.make("removed-codex")],
      lockedProvider: driver,
      lockedInstanceId: null,
    };
    const canonical = resolveComposerProviderSelection({
      ...selectionInput,
      entries: sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
      ),
    });
    const voiceEntries = deriveLiveVoiceProviderEntries(providers, settings, null);
    const voice = resolveComposerProviderSelection({ ...selectionInput, entries: voiceEntries });
    expect(canonical.selectedProviderEntry?.instanceId).toBe("codex");
    expect(voice.selectedProviderEntry?.instanceId).toBe(
      canonical.selectedProviderEntry?.instanceId,
    );
    const selected = voice.selectedProviderEntry!;
    await render({
      ...loaded,
      providerInstanceId: canonical.selectedProviderEntry!.instanceId,
      provider: selected,
      selectionCurrent: selected.instanceId === canonical.selectedProviderEntry?.instanceId,
      config: settings.providerInstances[selected.instanceId]?.config,
    });
    expect(startButton().disabled).toBe(false);
    expect(container.textContent).not.toContain("Waiting");
    expectPassive();
  });

  it.each([false, true])(
    "shows config projection failure with cached previous value=%s without qualifying it",
    async (cached) => {
      const previous = AsyncResult.success({ environmentId: environmentA });
      const failed = AsyncResult.failure(Cause.fail(new Error("private-config-cause")), {
        previousSuccess: cached ? Option.some(previous) : Option.none(),
      });
      expect(Option.isSome(AsyncResult.value(failed))).toBe(cached);
      await render({ ...loaded, configState: resolveLiveVoiceConfigState(failed) });
      expect(startButton().disabled).toBe(true);
      const failureHint = await startHint();
      expect(failureHint).toContain("Provider information could not be loaded");
      expect(failureHint).not.toContain("Waiting");
      expect(failureHint).not.toContain("private-config-cause");
      expect(container.textContent).not.toContain("Waiting");
      expect(container.textContent).not.toContain("private-config-cause");
      await act(async () => startButton().click());
      expectPassive();
      await render({
        ...loaded,
        environmentId: environmentB,
        configState: resolveLiveVoiceConfigState(AsyncResult.initial()),
      });
      expect(startButton().disabled).toBe(true);
      expect(await startHint()).toContain("Waiting for this environment's provider information");
      await render({
        ...loaded,
        environmentId: environmentB,
        catalogEnvironmentId: environmentB,
        configState: resolveLiveVoiceConfigState(
          AsyncResult.success({ environmentId: environmentB }),
        ),
      });
      expect(startButton().disabled).toBe(false);
      expectPassive();
    },
  );

  it("keeps the disabled reason out of the toolbar and opens it on deliberate keyboard focus", async () => {
    await render({ ...loaded, config: { setupMode: "existing" } });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain("Sign in to this Codex installation");
    const trigger = container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]');
    if (!trigger) throw new Error("Missing voice hint trigger");
    expect(trigger.tabIndex).toBe(0);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      trigger.focus();
    });
    expect(document.activeElement).toBe(trigger);
    expect(await startHint()).toContain("Sign in to this Codex installation");
    expectPassive();
  });
  it.each([
    ["managed", loaded],
    ["native ChatGPT", nativeLoaded],
  ] as const)(
    "enables %s setup passively and prepares only after a deliberate click",
    async (_name, input) => {
      await render(input);
      expect(startButton().disabled).toBe(false);
      expectPassive();
      await act(async () => startButton().click());
      expect(commands.prepare).toHaveBeenCalledOnce();
      expect(commands.prepare.mock.calls[0]?.[0]).toMatchObject({
        environmentId: environmentA,
        input: { threadId: thread },
      });
      expect(commands.start).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(peer).not.toHaveBeenCalled();
      expect(container.textContent).toContain("ChatGPT");
    },
  );

  it.each([
    {
      patch: { catalogEnvironmentId: null },
      reason: "Waiting for this environment's provider information.",
    },
    {
      patch: { settingsKnown: false },
      reason: "Waiting for this environment's provider settings.",
    },
    {
      patch: { config: { setupMode: "existing" } },
      reason: "Sign in to this Codex installation",
    },
    { patch: { instanceConfigured: false }, reason: "has no saved settings" },
    { patch: { config: null }, reason: "setup mode is missing" },
    { patch: { config: {} }, reason: "setup mode is invalid or missing" },
    { patch: { config: "private-invalid-value" }, reason: "setup mode is invalid or missing" },
    {
      patch: { permissionState: "pending", canOperate: false },
      reason: "Waiting for this environment's thread permissions",
    },
    {
      patch: { permissionState: "unavailable", canOperate: false },
      reason: "Thread permissions could not be verified",
    },
    {
      patch: { config: { setupMode: "private-invalid-value" } },
      reason: "setup mode is invalid",
    },
    {
      patch: { provider: null },
      reason: "selected provider instance is missing",
    },
    {
      patch: { provider: null, instanceRequested: false },
      reason: "Configure a Codex provider",
    },
    {
      patch: { provider: { ...loaded.provider!, enabled: false } },
      reason: "Enable the selected provider",
    },
    {
      patch: { provider: { ...loaded.provider!, isAvailable: false } },
      reason: "selected provider is unavailable",
    },
    {
      patch: { provider: { ...loaded.provider!, driverKind: "claudeCode" } },
      reason: "Select a Codex provider signed in with ChatGPT",
    },
    {
      patch: { canOperate: false },
      reason: "permission to operate this thread",
    },
    {
      patch: { selectionCurrent: false },
      reason: "provider selection to update",
    },
    { patch: { threadId: null }, reason: "Open an existing thread" },
    {
      patch: { providerInstanceId: null },
      reason: "provider selection to update",
    },
  ] satisfies ReadonlyArray<{
    patch: Partial<AvailabilityInput>;
    reason: string;
  }>)("explains $reason and blocks side effects", async ({ patch, reason }) => {
    await render({ ...loaded, ...patch });
    expect(startButton().disabled).toBe(true);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(await startHint()).toContain(reason);
    expect(container.textContent).not.toContain("private-invalid-value");
    expect(container.textContent).not.toContain(environmentA);
    expect(container.textContent).not.toContain(thread);
    await act(async () => startButton().click());
    expectPassive();
  });

  it.each(["WebRTC", "microphone"] as const)(
    "explains unavailable %s APIs without requesting access",
    async (missing) => {
      if (missing === "WebRTC") vi.stubGlobal("RTCPeerConnection", undefined);
      else
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: undefined,
        });
      await render(loaded);
      expect(startButton().disabled).toBe(true);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(await startHint()).toContain(
        missing === "WebRTC" ? "does not provide WebRTC" : "Microphone access is unavailable",
      );
      await act(async () => startButton().click());
      expectPassive();
    },
  );

  it("drops A's qualification during A to B scope changes and waits for B's own facts", async () => {
    await render(loaded);
    expect(startButton().disabled).toBe(false);
    await render(loaded, environmentB);
    expect(startButton().disabled).toBe(true);
    expect(await startHint()).toContain("voice availability to update");
    await act(async () => startButton().click());
    expectPassive();
    await render({ ...loaded, environmentId: environmentB });
    expect(startButton().disabled).toBe(true);
    expect(await startHint()).toContain("provider information");
    await render({
      ...loaded,
      environmentId: environmentB,
      catalogEnvironmentId: environmentB,
      canOperate: false,
    });
    expect(startButton().disabled).toBe(true);
    expect(await startHint()).toContain("permission to operate");
    await render({
      ...loaded,
      environmentId: environmentB,
      catalogEnvironmentId: environmentB,
    });
    expect(startButton().disabled).toBe(false);
    expectPassive();
  });
});
