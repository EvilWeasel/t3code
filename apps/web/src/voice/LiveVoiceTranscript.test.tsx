// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LiveVoiceState } from "@t3tools/client-runtime/live-voice";

const clipboard = vi.hoisted(() => ({ writeTextToClipboard: vi.fn() }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: clipboard.writeTextToClipboard,
}));

import { LiveVoiceTranscript } from "./LiveVoiceTranscript";

let root: Root;
let container: HTMLDivElement;

const transcript: LiveVoiceState["transcript"] = [
  { speaker: "user", text: "First question", final: true },
  { speaker: "assistant", text: "First answer", final: true },
  { speaker: "user", text: `Second question ${"full text ".repeat(70)}`, final: true },
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clipboard.writeTextToClipboard.mockReset().mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(entries: LiveVoiceState["transcript"]) {
  await act(async () => root.render(<LiveVoiceTranscript transcript={entries} />));
}

function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function pressEnter(target: HTMLButtonElement) {
  await act(async () => {
    target.focus();
    // jsdom does not synthesize the browser's native button activation after Enter.
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    target.click();
  });
}

describe("LiveVoiceTranscript", () => {
  it("opens the retained conversation, copies every full turn, and restores trigger focus on Escape", async () => {
    await render(transcript);
    const trigger = button("Transcript");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    expect(clipboard.writeTextToClipboard).not.toHaveBeenCalled();

    await pressEnter(trigger);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const list = dialog!.querySelector<HTMLOListElement>("ol");
    expect(list?.querySelectorAll("li")).toHaveLength(3);
    expect(list?.textContent).toContain("YouFirst question");
    expect(list?.textContent).toContain("LiveFirst answer");
    expect(list?.textContent).toContain(transcript[2]?.text);
    expect(list?.textContent?.length).toBeGreaterThan(500);
    expect(clipboard.writeTextToClipboard).not.toHaveBeenCalled();

    const expectedCopy = transcript
      .map((entry) => `${entry.speaker === "user" ? "You" : "Live"}:\n${entry.text}`)
      .join("\n\n");
    await click("Copy transcript");
    expect(clipboard.writeTextToClipboard).toHaveBeenCalledWith(expectedCopy, "Live transcript");
    expect(dialog?.textContent).toContain("Transcript copied.");

    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(clipboard.writeTextToClipboard).toHaveBeenCalledOnce();
  });

  it("reports a copy failure truthfully and lets the user retry", async () => {
    clipboard.writeTextToClipboard.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await render(transcript);
    await click("Transcript");
    await click("Copy transcript");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t copy transcript. Try again.",
    );
    expect(document.querySelector('[role="status"]')?.textContent).not.toContain("copied");

    await click("Copy transcript");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Transcript copied.");
    expect(clipboard.writeTextToClipboard).toHaveBeenCalledTimes(2);
  });

  it("closes and clears when the current session transcript resets", async () => {
    await render(transcript);
    await click("Transcript");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await render([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector("button")).toBeNull();
    expect(clipboard.writeTextToClipboard).not.toHaveBeenCalled();
  });
});
