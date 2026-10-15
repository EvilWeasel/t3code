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
  resolveLiveVoiceControlGate,
} from "./LiveVoiceControl";
import { TooltipProvider } from "~/components/ui/tooltip";
import { unwrapLiveVoiceCommand } from "./LiveVoiceCommands";
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

let root: Root;
let container: HTMLDivElement;
const getUserMedia = vi.fn();
const peer = vi.fn();

beforeEach(() => {
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
  vi.unstubAllGlobals();
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
    expect(container.querySelector('[role="status"]')?.textContent).toBe(next.gate.reason);
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
      expect(container.textContent).toContain("Provider information could not be loaded");
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
      expect(container.textContent).toContain(
        "Waiting for this environment's provider information",
      );
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

  it("keeps the disabled tooltip trigger keyboard reachable and the exact reason visible", async () => {
    await render({ ...loaded, config: { setupMode: "existing" } });
    const trigger = container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')!;
    expect(trigger.tabIndex).toBe(0);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      trigger.focus();
    });
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "existing installation",
    );
    expectPassive();
  });
  it("enables loaded managed setup without probing, and only prepares after a deliberate click", async () => {
    await render(loaded);
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
  });

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
      reason: "uses an existing installation",
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
      reason: "Select a managed Codex provider",
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
    expect(container.querySelector('[role="status"]')?.textContent).toContain(reason);
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
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
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
    expect(container.textContent).toContain("voice availability to update");
    await act(async () => startButton().click());
    expectPassive();
    await render({ ...loaded, environmentId: environmentB });
    expect(startButton().disabled).toBe(true);
    expect(container.textContent).toContain("provider information");
    await render({
      ...loaded,
      environmentId: environmentB,
      catalogEnvironmentId: environmentB,
      canOperate: false,
    });
    expect(startButton().disabled).toBe(true);
    expect(container.textContent).toContain("permission to operate");
    await render({
      ...loaded,
      environmentId: environmentB,
      catalogEnvironmentId: environmentB,
    });
    expect(startButton().disabled).toBe(false);
    expectPassive();
  });
});
