// @vitest-environment jsdom

import { act, createRef, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  ThreadId,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({
  prepare: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  status: vi.fn(),
}));
vi.mock("../../state/liveVoice", () => ({
  liveVoiceEnvironment: {
    prepare: "prepare",
    start: "start",
    stop: "stop",
    status: "status",
    events: vi.fn(),
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: keyof typeof commands) => commands[name],
}));

import {
  ChatComposerFooter,
  ComposerFooterModeControls,
  useLiveVoiceComposerState,
} from "./ChatComposer";
import { LiveVoiceControl, resolveLiveVoiceAvailability } from "../../voice/LiveVoiceControl";
import { Button } from "../ui/button";
import { TooltipProvider } from "../ui/tooltip";
import { runtimeModeConfig, runtimeModeOptions } from "./runtimeModeConfig";

const environmentId = EnvironmentId.make("mobile-fixture");
const threadId = ThreadId.make("mobile-fixture-thread");
const getUserMedia = vi.fn();
const peer = vi.fn();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("RTCPeerConnection", peer);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  for (const command of Object.values(commands)) command.mockReset();
  getUserMedia.mockReset();
  peer.mockReset();
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

function control(label: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing ${label}`);
  return element;
}

function expectPassive() {
  expect(commands.prepare).not.toHaveBeenCalled();
  expect(commands.start).not.toHaveBeenCalled();
  expect(commands.status).not.toHaveBeenCalled();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(peer).not.toHaveBeenCalled();
}

describe("production composer mobile footer", () => {
  it("keeps unfocused voice controls mounted through draft hydration until deliberate End", async () => {
    let finishSaving!: () => void;
    const saving = new Promise<void>((resolve) => {
      finishSaving = resolve;
    });
    const availability = resolveLiveVoiceAvailability({
      environmentId,
      threadId,
      providerInstanceId: "codex",
      catalogEnvironmentId: environmentId,
      configState: "ready",
      settingsKnown: true,
      canOperate: true,
      permissionState: "known",
      selectionCurrent: true,
      instanceRequested: true,
      provider: { driverKind: "codex", enabled: true, isAvailable: true },
      instanceConfigured: true,
      config: { setupMode: "managed" },
    });
    function Fixture() {
      const [heroExpanded, setHeroExpanded] = useState(true);
      const voice = useLiveVoiceComposerState("same-scoped-draft-thread");
      const beforePrepare = useCallback(async () => {
        setHeroExpanded(false);
        await saving;
      }, [saving]);
      return (
        <TooltipProvider delay={0}>
          <textarea aria-label="Unfocused message" defaultValue="Keep this draft" />
          <ChatComposerFooter
            hidden={!heroExpanded}
            keepVisibleForLiveVoice={voice.keepVisible}
            compact={false}
            pendingInput={false}
            mobilePendingActions={!heroExpanded}
            resting={false}
            inlineResting={false}
            primaryActionsCompact={false}
            controls={null}
            actions={
              <LiveVoiceControl
                environmentId={environmentId}
                threadId={threadId}
                providerInstanceId="codex"
                eligible
                availability={availability}
                beforePrepare={beforePrepare}
                onPhaseChange={voice.onPhaseChange}
              />
            }
          />
        </TooltipProvider>
      );
    }
    await act(async () => root.render(<Fixture />));
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Unfocused message"]');
    expect(document.activeElement).not.toBe(editor);
    await act(async () => control("Start voice call").click());
    const end = control("End Live voice");
    const footer = container.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
    expect(footer).not.toBeNull();
    expect(footer?.classList.contains("hidden")).toBe(false);
    expect(container.querySelector('[data-live-voice-phase="preparing"]')).not.toBeNull();
    expect(editor?.value).toBe("Keep this draft");
    expect(document.activeElement).not.toBe(editor);
    expectPassive();
    await act(async () => end.click());
    expect(container.querySelector('[data-chat-composer-footer="true"]')).toBeNull();
    await act(async () => {
      finishSaving();
      await saving;
    });
    expect(container.querySelector('[data-chat-composer-footer="true"]')).toBeNull();
    expectPassive();
    expect(commands.stop).not.toHaveBeenCalled();
  });

  it("keeps real disabled Live control compact while preserving child focus, actions and form submission", async () => {
    const send = vi.fn();
    const attach = vi.fn();
    const options = vi.fn();
    const controlsRef = createRef<HTMLDivElement>();
    const actionsRef = createRef<HTMLDivElement>();
    const availability = resolveLiveVoiceAvailability({
      environmentId,
      threadId,
      providerInstanceId: "codex",
      catalogEnvironmentId: environmentId,
      configState: "ready",
      settingsKnown: true,
      canOperate: true,
      permissionState: "known",
      selectionCurrent: true,
      instanceRequested: true,
      provider: { driverKind: "codex", enabled: true, isAvailable: true },
      instanceConfigured: false,
      config: undefined,
    });
    function Fixture() {
      const [draft, setDraft] = useState("");
      return (
        <TooltipProvider delay={0}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              send(draft);
            }}
          >
            <textarea
              aria-label="Message"
              value={draft}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
            <ChatComposerFooter
              compact={false}
              pendingInput={false}
              mobilePendingActions={false}
              resting={false}
              inlineResting={false}
              primaryActionsCompact={false}
              controlsRef={controlsRef}
              actionsRef={actionsRef}
              controls={
                <Button type="button" aria-label="Options" onClick={options}>
                  Long model and context options
                </Button>
              }
              actions={
                <>
                  <LiveVoiceControl
                    environmentId={environmentId}
                    threadId={threadId}
                    providerInstanceId="codex"
                    eligible={false}
                    availability={availability}
                  />
                  <Button type="button" aria-label="Attach files" onClick={attach}>
                    Attach
                  </Button>
                  <Button type="submit" aria-label="Send message">
                    Send
                  </Button>
                </>
              }
            />
          </form>
        </TooltipProvider>
      );
    }
    await act(async () => root.render(<Fixture />));
    expect(controlsRef.current?.contains(control("Options"))).toBe(true);
    expect(actionsRef.current?.contains(control("Send message"))).toBe(true);
    expect(control("Start voice call").disabled).toBe(true);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain("has no saved settings");
    expectPassive();

    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]');
    if (!editor) throw new Error("Missing editor");
    await act(async () => {
      editor.focus();
      editor.value = "Keep this draft";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.activeElement).toBe(editor);
    await act(async () => control("Options").click());
    await act(async () => control("Attach files").click());
    await act(async () => control("Start voice call").click());
    expect(options).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledOnce();
    expect(editor.value).toBe("Keep this draft");
    expectPassive();
    await act(async () => control("Send message").click());
    expect(send).toHaveBeenCalledExactlyOnceWith("Keep this draft");
    expectPassive();
  });
});

it("opens the production grouped configuration deliberately, preserves choices and returns focus", async () => {
  const changedMode = vi.fn();
  const changedInteraction = vi.fn();
  const send = vi.fn();
  const attach = vi.fn();
  function Fixture() {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<RuntimeMode>("approval-required");
    const [interaction, setInteraction] = useState<ProviderInteractionMode>("default");
    const [draft, setDraft] = useState("Keep this draft");
    return (
      <TooltipProvider delay={0}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
        >
          <textarea
            aria-label="Message"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <ChatComposerFooter
            compact={false}
            pendingInput={false}
            mobilePendingActions={false}
            resting={false}
            inlineResting={false}
            primaryActionsCompact={false}
            mobileConfiguration={{ label: "GPT-6.1-Sol", open, onOpenChange: setOpen }}
            controls={
              <ComposerFooterModeControls
                showInteractionModeToggle
                interactionMode={interaction}
                runtimeMode={mode}
                runtimeModeOptions={runtimeModeOptions.map((value) => ({
                  mode: value,
                  ...runtimeModeConfig[value],
                }))}
                onRuntimeModeChange={(value) => {
                  changedMode(value);
                  setMode(value);
                }}
                onToggleInteractionMode={() => {
                  const value = interaction === "default" ? "plan" : "default";
                  changedInteraction(value);
                  setInteraction(value);
                }}
              />
            }
            actions={
              <>
                <Button type="button" aria-label="Attach files" onClick={attach}>
                  Attach
                </Button>
                <Button type="submit" aria-label="Send message">
                  Send
                </Button>
              </>
            }
          />
        </form>
      </TooltipProvider>
    );
  }
  await act(async () => root.render(<Fixture />));
  const trigger = control("Model and configuration");
  expect(trigger.getAttribute("aria-description")).toBe("GPT-6.1-Sol");
  expect(trigger.textContent).toBe("Model");
  expect(document.querySelector('[aria-label="Runtime mode"]')).toBeNull();
  expect(changedMode).not.toHaveBeenCalled();
  expect(changedInteraction).not.toHaveBeenCalled();
  expectPassive();
  await act(async () => {
    trigger.focus();
    trigger.click();
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const runtime = document.querySelector<HTMLButtonElement>('[aria-label="Runtime mode"]');
  if (!runtime) throw new Error("Missing actual runtime picker");
  await act(async () => runtime.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
    element.textContent?.includes("Full access"),
  );
  if (!option) throw new Error("Missing actual Full access choice");
  await act(async () => option.click());
  expect(changedMode).toHaveBeenCalledExactlyOnceWith("full-access");
  expect(changedInteraction).not.toHaveBeenCalled();
  const plan = document.querySelector<HTMLButtonElement>(
    '[aria-label="Default mode — click to enter plan mode"]',
  );
  if (!plan) throw new Error("Missing actual interaction control");
  await act(async () => plan.click());
  expect(changedInteraction).toHaveBeenCalledExactlyOnceWith("plan");
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close configuration"]');
  if (!close) throw new Error("Missing configuration close");
  await act(async () => close.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  expect(document.querySelector('[aria-label="Runtime mode"]')?.textContent).toContain(
    "Full access",
  );
  expect(
    document.querySelector('[aria-label="Plan mode — click to return to normal build mode"]'),
  ).not.toBeNull();
  const closeAgain = document.querySelector<HTMLButtonElement>(
    '[aria-label="Close configuration"]',
  );
  if (!closeAgain) throw new Error("Missing reopened configuration close");
  await act(async () => closeAgain.click());
  const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Message"]');
  expect(editor?.value).toBe("Keep this draft");
  await act(async () => control("Attach files").click());
  expect(attach).toHaveBeenCalledOnce();
  await act(async () => control("Send message").click());
  expect(send).toHaveBeenCalledExactlyOnceWith("Keep this draft");
  expectPassive();
});
