// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  LiveVoiceError,
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
  LiveVoiceControl,
  resolveLiveVoiceAvailability,
  resolveLiveVoiceConfigState,
} from "./LiveVoiceControl";
import { TooltipProvider } from "~/components/ui/tooltip";
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

describe("LiveVoiceControl passive availability", () => {
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
