// @vitest-environment jsdom

import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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

import { ChatComposerFooter } from "./ChatComposer";
import { LiveVoiceControl, resolveLiveVoiceAvailability } from "../../voice/LiveVoiceControl";
import { Button } from "../ui/button";
import { TooltipProvider } from "../ui/tooltip";

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
