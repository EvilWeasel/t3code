// @vitest-environment jsdom
import { EnvironmentId, RuntimeRequestId } from "@t3tools/contracts";
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const harness = vi.hoisted(() => ({ presses: new Map<string, () => void>() }));
vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => {
      const label =
        React.isValidElement<{ children?: ReactNode }>(children) &&
        typeof children.props.children === "string"
          ? children.props.children
          : "details";
      if (onPress) harness.presses.set(label, onPress);
      return (
        <button disabled={disabled} onClick={onPress}>
          {children}
        </button>
      );
    },
  };
});
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
import { PendingApprovalCard } from "./PendingApprovalCard";
let root: Root | undefined;
let host: HTMLDivElement;
const requestId = RuntimeRequestId.make("mobile-approval");
const approval = {
  requestId,
  requestKind: "command" as const,
  createdAt: "2026-10-15T00:00:00.000Z",
  responseCapability: "live" as const,
  detail: "pwsh -Command {\n  Write-Output '脚本'\n}\n" + "# original\n".repeat(100),
  options: [
    { decision: "accept" as const, label: "Provider allows once" },
    { decision: "decline" as const, label: "Deny" },
    { decision: "cancel" as const, label: "Cancel request" },
  ],
};
const respond = vi.fn(async (_id: RuntimeRequestId, _decision: string) => undefined);
type Props = ComponentProps<typeof PendingApprovalCard>;
function render(overrides: Partial<Props> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      <PendingApprovalCard
        approval={approval}
        environmentId={EnvironmentId.make("env-a")}
        environmentLabel="Hephaestus"
        runtimeMode="auto"
        canOperateThread
        respondingApprovalId={null}
        onRespond={respond}
        {...overrides}
      />,
    ),
  );
}
function button(label: string) {
  const result = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(result).toBeDefined();
  return result!;
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  harness.presses.clear();
  respond.mockReset();
  vi.unstubAllGlobals();
});

describe("PendingApprovalCard", () => {
  it("shows the real peer, configured mode and exact expandable code without inferring sudo rights", () => {
    render();
    expect(host.textContent).toContain("Hephaestus");
    expect(host.textContent).toContain("Auto");
    expect(host.textContent).not.toContain(approval.detail);
    act(() => button("Show provider details").click());
    expect(host.textContent).toContain(approval.detail);
    expect(host.textContent).toContain("OS privilege: Not supplied");
    expect(host.textContent).toContain("Effective provider policy: Not supplied");
    expect(host.textContent).toContain("Execution unconfirmed");
  });
  it("preserves provider-supported reject/cancel choices and fallback warnings", async () => {
    render({
      approval: {
        ...approval,
        options: [
          {
            decision: "accept",
            label: "Allow once only",
            warning: "Provider cannot grant the requested session scope.",
          },
          { decision: "cancel", label: "Stop this request" },
        ],
      },
    });
    expect(host.textContent).toContain("Provider cannot grant the requested session scope.");
    expect(host.textContent).not.toContain("Allow session");
    await act(async () => button("Stop this request").click());
    expect(respond).toHaveBeenCalledWith(requestId, "cancel");
  });
  it("refuses stale/nonresumable or permission-revoked callbacks", async () => {
    render();
    const stale = harness.presses.get("Provider allows once")!;
    render({ approval: { ...approval, responseCapability: "not_resumable" } });
    await act(async () => stale());
    expect(respond).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Provider disconnected");
    render({ canOperateThread: false });
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
  });
  it("does not retarget an old callback or old detail disclosure after switching peers", async () => {
    render();
    const stale = harness.presses.get("Provider allows once")!;
    act(() => button("Show provider details").click());
    render({ environmentId: EnvironmentId.make("env-b"), environmentLabel: "Blain37" });
    await act(async () => stale());
    expect(respond).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Blain37");
    expect(host.textContent).not.toContain("Hephaestus");
    expect(host.textContent).not.toContain(approval.detail);
    await act(async () => button("Deny").click());
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
  });
  it("submits only once while a decision is in flight", async () => {
    let complete!: () => void;
    const pending = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    render({ onRespond: pending });
    const press = harness.presses.get("Provider allows once")!;
    act(() => {
      press();
      press();
    });
    expect(pending).toHaveBeenCalledTimes(1);
    await act(async () => complete());
  });
  it("keeps a failed response retryable without presenting a completed action", async () => {
    respond.mockRejectedValueOnce(new Error("private error"));
    render();
    await act(async () => button("Provider allows once").click());
    expect(host.textContent).toContain("The request is still pending");
    expect(host.textContent).not.toContain("private error");
    await act(async () => button("Provider allows once").click());
    expect(respond).toHaveBeenCalledTimes(2);
  });
});
