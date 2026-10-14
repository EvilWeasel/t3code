// @vitest-environment jsdom
import { EnvironmentId, RuntimeRequestId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { PendingApproval } from "../../session-logic";
import { ApprovalActionSummary, type ApprovalActionSummaryProps } from "./ApprovalActionSummary";

let root: Root | undefined;
let host: HTMLDivElement;
const approval: PendingApproval = {
  requestId: RuntimeRequestId.make("approval-visual"),
  requestKind: "command",
  createdAt: "2026-10-15T00:00:00.000Z",
  responseCapability: "live",
  detail: "sudo bash -c 'printf 执行\\n'\n" + "# long code\n".repeat(200),
};
function render(props: Partial<ApprovalActionSummaryProps> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root!.render(<ApprovalActionSummary approval={approval} {...props} />));
}
function value(label: string) {
  return [...host.querySelectorAll("dt")].find((item) => item.textContent === label)
    ?.nextElementSibling?.textContent;
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  vi.unstubAllGlobals();
});

describe("ApprovalActionSummary", () => {
  it("keeps exact long Unicode provider code available without interpreting OS authority", () => {
    render({ environmentId: EnvironmentId.make("peer-heph"), runtimeMode: "auto" });
    host.querySelector("summary")!.click();
    expect(host.querySelector("pre")?.textContent).toBe(approval.detail);
    expect(value("OS privilege")).toBe("Not supplied");
    expect(value("Effective provider policy")).toBe("Not supplied");
    expect(value("Configured mode")).toBe("Auto");
    expect(host.textContent).toContain("Execution unconfirmed");
    expect(host.textContent).toContain("Verification unconfirmed");
  });
  it("updates the actual peer target and closes old details when environments switch", () => {
    render({ environmentId: EnvironmentId.make("peer-a"), environmentLabel: "Hephaestus" });
    host.querySelector("summary")!.click();
    expect(host.querySelector("details")?.open).toBe(true);
    render({ environmentId: EnvironmentId.make("peer-b"), environmentLabel: "Blain37" });
    expect(value("Destination environment")).toBe("Blain37");
    expect(value("Environment ID")).toBe("peer-b");
    expect(host.textContent).not.toContain("Hephaestus");
    expect(host.querySelector("details")?.open).toBe(false);
  });
  it("preserves provider-specific scope labels and fallback warnings without inventing a grant", () => {
    render({
      approval: {
        ...approval,
        options: [
          {
            decision: "acceptAlways",
            label: "Allow Safari",
            warning: "Provider applies this choice once for this request.",
          },
          { decision: "cancel", label: "Cancel request" },
        ],
      },
    });
    expect(host.textContent).toContain("Allow Safari");
    expect(host.textContent).toContain("Provider applies this choice once for this request.");
    expect(host.textContent).not.toContain("Always allow this session");
    expect(value("Structured resource scope")).toBe("Not supplied");
  });
  it("keeps original request details inspectable after provider disconnection", () => {
    render({ approval: { ...approval, responseCapability: "not_resumable" } });
    host.querySelector("summary")!.click();
    expect(host.textContent).toContain("Provider disconnected");
    expect(host.querySelector("pre")?.textContent).toBe(approval.detail);
  });
  it("does not create a confirmation for full-access mode without an actual approval", () => {
    render({ approval: null, runtimeMode: "full-access" });
    expect(host.textContent).toBe("");
    expect(host.querySelector("button")).toBeNull();
  });
});
