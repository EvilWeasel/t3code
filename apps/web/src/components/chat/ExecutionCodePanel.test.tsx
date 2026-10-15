// @vitest-environment jsdom
import {
  EnvironmentId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as DateTime from "effect/DateTime";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../state/queries", () => ({ useTurnItemDetail: harness.query }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("./HighlightedTokens", () => ({ HighlightedTokens: ({ code }: { code: string }) => code }));
import { ExecutionCodePanel } from "./ExecutionCodePanel";

const environmentId = EnvironmentId.make("heph");
const base = {
  id: TurnItemId.make("execution-original"),
  threadId: ThreadId.make("thread-original"),
  runId: RunId.make("run-original"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "running" as const,
  title: null,
  startedAt: DateTime.makeUnsafe("2026-10-15T00:00:00Z"),
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-15T00:00:01Z"),
};
const input = "  python3 - <<'PY'\nprint('original 🦦')\nPY\n" + "# long\n".repeat(400);
const item: OrchestrationV2TurnItem = {
  ...base,
  type: "command_execution",
  input,
  outputOmitted: true,
};
let root: Root | undefined;
let host: HTMLDivElement;
function render(overrides: Partial<ComponentProps<typeof ExecutionCodePanel>> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      <ExecutionCodePanel
        threadRef={scopeThreadRef(environmentId, base.threadId)}
        target={{ environmentId, threadId: base.threadId, itemId: base.id, runId: base.runId }}
        wireItem={item}
        {...overrides}
      />,
    ),
  );
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  harness.query.mockReset();
  vi.unstubAllGlobals();
});
const inputText = () => host.querySelector('[aria-label="Recorded input"]')?.textContent;
describe("execution code panel", () => {
  it("does not query another environment while panel presence still holds the old surface", () => {
    harness.query.mockReturnValue({ data: { item }, isPending: false, error: null });
    render({ threadRef: scopeThreadRef(EnvironmentId.make("other-host"), base.threadId) });
    expect(harness.query).toHaveBeenLastCalledWith(null);
    expect(inputText()).toBeUndefined();
  });
  it("shows an explicitly recorded script field on real lines, retaining the full arguments separately", () => {
    const code = "function greet() {\n  return '🦦';\n}\ngreet();\n";
    const dynamic: OrchestrationV2TurnItem = {
      ...base,
      type: "dynamic_tool",
      toolName: "js",
      input: { code, extra: "original argument" },
    };
    harness.query.mockReturnValue({ data: { item: dynamic }, isPending: false, error: null });
    render({ wireItem: dynamic });
    expect(inputText()).toBe(code);
    expect(host.querySelector('[aria-label="Complete structured input"]')?.textContent).toContain(
      '"extra": "original argument"',
    );
  });
  it("retains complete large code while omitting expensive syntax coloring", () => {
    const large = "# original 🦦\n".repeat(10_000);
    harness.query.mockReturnValue({ data: null, isPending: false, error: null });
    render({ wireItem: { ...item, input: large } });
    expect(inputText()).toBe(large);
    expect(host.textContent).toContain("complete plain text");
  });
  it("fetches through the existing authorized item route and keeps command/output separate after completion", () => {
    harness.query.mockReturnValue({ data: null, isPending: true, error: null });
    render();
    expect(inputText()).toBe(input);
    expect(harness.query).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environmentId,
        threadId: base.threadId,
        itemId: base.id,
        revision: "live",
      }),
    );
    const completed = {
      ...item,
      status: "completed",
      completedAt: DateTime.makeUnsafe("2026-10-15T00:00:02Z"),
      updatedAt: DateTime.makeUnsafe("2026-10-15T00:00:02Z"),
      output: "separate stdout/stderr",
      outputOmitted: false,
    };
    harness.query.mockReturnValue({ data: { item: completed }, isPending: false, error: null });
    render({ wireItem: completed as OrchestrationV2TurnItem });
    expect(inputText()).toBe(input);
    expect(host.querySelector('[aria-label="Recorded output"]')?.textContent).toBe(
      "separate stdout/stderr",
    );
    expect(host.textContent).toContain("completed");
    expect(host.textContent).toContain("Not supplied for this execution");
    expect(host.textContent).toContain("historical file contents");
  });
  it("copies the exact input including whitespace and finds Unicode without running anything", async () => {
    harness.query.mockReturnValue({ data: null, isPending: false, error: null });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render();
    const search = host.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "🦦");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("Matches on lines 2");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Copy input")!
        .click(),
    );
    expect(writeText).toHaveBeenCalledExactlyOnceWith(input);
    expect(inputText()).toBe(input);
  });
  it("never retargets a late item read across thread/environment/run switches", () => {
    harness.query.mockReturnValue({ data: { item }, isPending: false, error: null });
    render();
    render({
      threadRef: scopeThreadRef(EnvironmentId.make("other-host"), ThreadId.make("other-thread")),
      target: {
        environmentId: EnvironmentId.make("other-host"),
        threadId: ThreadId.make("other-thread"),
        itemId: base.id,
        runId: RunId.make("other-run"),
      },
      wireItem: undefined,
    });
    expect(inputText()).toBeUndefined();
    expect(host.textContent).not.toContain(input);
    expect(host.textContent).toContain("other-host");
  });
  it("does not replace full projected command input with the detail route's truncated prefix", () => {
    harness.query.mockReturnValue({
      data: { item: { ...item, input: "prefix\n… output truncated for transport" } },
      isPending: false,
      error: null,
    });
    render();
    expect(inputText()).toBe(input);
  });
  it("reports unavailable input, missing records and authorized read failures without fabricating code", () => {
    harness.query.mockReturnValue({
      data: {
        item: {
          ...base,
          type: "dynamic_tool",
          toolName: "code",
          input: { summary: "prefix", truncated: true },
        },
      },
      isPending: false,
      error: null,
    });
    render({ wireItem: undefined });
    expect(inputText()).toBeUndefined();
    expect(host.textContent).toContain("Complete recorded input is unavailable");
    harness.query.mockReturnValue({ data: { item: null }, isPending: false, error: "not found" });
    render({ wireItem: undefined });
    expect(host.textContent).toContain("authorized item read failed");
  });
});
