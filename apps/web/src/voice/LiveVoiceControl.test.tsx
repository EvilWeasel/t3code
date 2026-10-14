// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

const calls = vi.hoisted(() => ({ command: vi.fn(), start: vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => calls.command }));
vi.mock("../state/liveVoice", () => ({ liveVoiceEnvironment: {} }));
vi.mock("./LiveVoiceTranscript", () => ({ LiveVoiceTranscript: () => null }));
vi.mock("@t3tools/client-runtime/live-voice", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/live-voice")>()),
  LiveVoiceController: class {
    contextChanged() {
      return Promise.resolve();
    }
    end() {
      return Promise.resolve();
    }
    start = calls.start;
  },
}));
import { LiveVoiceControl } from "./LiveVoiceControl";
import { TooltipProvider } from "~/components/ui/tooltip";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("RTCPeerConnection", class {});
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
  calls.command.mockClear();
  calls.start.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps unavailable Live quiet until the disabled control is focused", async () => {
  const reason = "Live voice is available only for a managed Codex thread.";
  await act(async () =>
    root.render(
      <TooltipProvider delay={0}>
        <LiveVoiceControl
          environmentId={EnvironmentId.make("environment")}
          threadId={ThreadId.make("thread")}
          providerInstanceId="codex"
          eligible={false}
          unavailableReason={reason}
        />
      </TooltipProvider>,
    ),
  );
  expect(container.textContent).not.toContain(reason);
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Start Live voice"]',
  )!;
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(calls.start).not.toHaveBeenCalled();
  const trigger = container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')!;
  expect(trigger.tabIndex).toBe(0);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    trigger.focus();
  });
  expect(document.activeElement).toBe(trigger);
  await vi.waitFor(() =>
    expect(document.querySelector('[role="tooltip"]')?.textContent, document.body.innerHTML).toContain(reason),
  );
  expect(calls.command).not.toHaveBeenCalled();
});
