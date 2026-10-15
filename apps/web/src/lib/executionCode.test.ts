import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { executionCode, matchesExecutionTarget } from "./executionCode";

const base = {
  id: TurnItemId.make("item-code"),
  threadId: ThreadId.make("thread-code"),
  runId: RunId.make("run-code"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-15T00:00:00Z"),
};
const command = (input: string): OrchestrationV2TurnItem => ({
  ...base,
  type: "command_execution",
  input,
  output: "separate output",
  exitCode: 0,
});
describe("recorded execution input", () => {
  it.each([
    "\n  bash -lc 'printf 执行'\n",
    "pwsh -Command {\r\n  Write-Output '脚本'\r\n}\r\n",
    "python3 - <<'PY'\nprint('héllo 🦦')\nPY\n",
    "# Unicode 🦦\n".repeat(6000),
  ])("preserves complete command bytes including whitespace: %#", (input) => {
    const view = executionCode(command(input))!;
    expect(view.text).toBe(input);
    expect(view.output).toBe("separate output");
    expect(view.exitCode).toBe(0);
  });
  it("uses PowerShell grammar without rewriting the invocation or reading script files", () => {
    const view = executionCode(command("pwsh -File ./historical.ps1"))!;
    expect(view.language).toBe("powershell");
    expect(view.text).toBe("pwsh -File ./historical.ps1");
    expect(view.cwd).toBeNull();
  });
  it("retains structured tool arguments and actual recorded cwd", () => {
    const input = {
      code: "function f() {\n return '🦦';\n}\nf();\n",
      cwd: "/original/run",
      extra: [1, 2],
    };
    const view = executionCode({ ...base, type: "dynamic_tool", toolName: "code", input })!;
    expect(view.text).toBe(input.code);
    expect(JSON.parse(view.argumentsText!)).toEqual(input);
    expect(view.inputField).toBe("code");
    expect(view.cwd).toBe("/original/run");
  });
  it.each([{ summary: "not all code", truncated: true }, { redacted: true }, null, ""])(
    "does not present missing/redacted/summarized data as complete input: %#",
    (input) => {
      expect(
        executionCode({ ...base, type: "dynamic_tool", toolName: "code", input })?.text,
      ).toBeNull();
    },
  );
  it("reports the existing detail transport limit explicitly", () => {
    const view = executionCode(command("partial\n… output truncated for transport"))!;
    expect(view.text).toBeNull();
    expect(view.unavailable).toContain("transport limit");
  });
  it("rejects a stale run or thread even when an item ID is reused", () => {
    const item = command("echo original");
    const target = { threadId: base.threadId, itemId: base.id, runId: base.runId };
    expect(matchesExecutionTarget(item, target)).toBe(true);
    expect(matchesExecutionTarget(item, { ...target, threadId: ThreadId.make("other") })).toBe(
      false,
    );
    expect(matchesExecutionTarget(item, { ...target, runId: RunId.make("other") })).toBe(false);
  });
  it("does not turn assistant text into execution code or withheld output into evidence", () => {
    expect(
      executionCode({
        ...base,
        type: "command_execution",
        input: "echo actual",
        output: "withheld",
        outputOmitted: true,
      })?.output,
    ).toBeNull();
    expect(
      executionCode({ ...base, type: "reasoning", text: "I would run this", streaming: false }),
    ).toBeNull();
  });
});
