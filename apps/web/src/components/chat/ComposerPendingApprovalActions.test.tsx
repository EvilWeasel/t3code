// @vitest-environment jsdom
import { RuntimeRequestId, type ProviderApprovalOption } from "@t3tools/contracts";
import { act, type ReactNode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ handlers: new Map<string, () => void>() }));
vi.mock("../ui/button", async () => {
  const React = await import("react");
  const text = (children: ReactNode): string =>
    React.Children.toArray(children)
      .map((child) =>
        typeof child === "string"
          ? child
          : React.isValidElement<{ children?: ReactNode }>(child)
            ? text(child.props.children)
            : "",
      )
      .join("");
  return {
    Button: ({
      children,
      onClick,
      disabled,
      "aria-label": label,
    }: {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      "aria-label"?: string;
    }) => {
      if (onClick) harness.handlers.set(label ?? text(children), onClick);
      return (
        <button disabled={disabled} aria-label={label} onClick={onClick}>
          {children}
        </button>
      );
    },
  };
});
vi.mock("../ui/menu", async () => {
  const React = await import("react");
  const Context = React.createContext({ open: false, toggle: () => {} });
  return {
    Menu: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      return (
        <Context.Provider value={{ open, toggle: () => setOpen((value) => !value) }}>
          {children}
        </Context.Provider>
      );
    },
    MenuTrigger: ({
      render,
      children,
      disabled,
    }: {
      render: ReactElement<{ onClick?: () => void; disabled?: boolean; children?: ReactNode }>;
      children: ReactNode;
      disabled?: boolean;
    }) => {
      const context = React.useContext(Context);
      return React.cloneElement(render, { disabled, onClick: context.toggle, children });
    },
    MenuPopup: ({ children }: { children: ReactNode }) =>
      React.useContext(Context).open ? <div role="menu">{children}</div> : null,
    MenuItem: ({
      children,
      disabled,
      onClick,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onClick?: () => void;
    }) => (
      <button role="menuitem" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
let root: Root | undefined;
let host: HTMLDivElement;
const requestId = RuntimeRequestId.make("approval-response");
const options: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "decline", label: "Deny" },
  { decision: "cancel", label: "Cancel request" },
];
const respond = vi.fn(async (_id: RuntimeRequestId, _decision: string) => undefined);
type Props = React.ComponentProps<typeof ComposerPendingApprovalActions>;
function render(overrides: Partial<Props> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      <ComposerPendingApprovalActions
        requestId={requestId}
        canRespond
        isResponding={false}
        options={options}
        onRespondToApproval={respond}
        {...overrides}
      />,
    ),
  );
}
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  expect(found).toBeDefined();
  return found!;
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  harness.handlers.clear();
  respond.mockReset();
  vi.unstubAllGlobals();
});

describe("ComposerPendingApprovalActions", () => {
  it("submits actual provider decisions, including reject and cancel", async () => {
    render();
    await act(async () => button("Deny").click());
    expect(respond).toHaveBeenLastCalledWith(requestId, "decline");
    act(() => button("More approval options").click());
    await act(async () => button("Cancel request").click());
    expect(respond).toHaveBeenLastCalledWith(requestId, "cancel");
  });
  it("blocks every decision on nonresumable requests, including an already-open more menu", async () => {
    render();
    act(() => button("More approval options").click());
    render({ canRespond: false });
    await act(async () => {
      button("Allow once").click();
      button("Deny").click();
      button("Cancel request").click();
    });
    expect(respond).not.toHaveBeenCalled();
  });
  it("coalesces repeated clicks before parent responding state reaches the component", async () => {
    let complete!: () => void;
    const pending = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    render({ onRespondToApproval: pending });
    const click = harness.handlers.get("Allow once")!;
    act(() => {
      click();
      click();
    });
    expect(pending).toHaveBeenCalledTimes(1);
    await act(async () => complete());
  });
  it("refuses stale callbacks after the request or destination-bound responder changes", async () => {
    const first = vi.fn(async () => undefined);
    const next = vi.fn(async () => undefined);
    render({ onRespondToApproval: first });
    const stale = harness.handlers.get("Allow once")!;
    render({ onRespondToApproval: next });
    await act(async () => stale());
    expect(first).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    await act(async () => button("Allow once").click());
    expect(next).toHaveBeenCalledWith(requestId, "accept");
    const oldRequest = harness.handlers.get("Allow once")!;
    render({ requestId: RuntimeRequestId.make("approval-new"), onRespondToApproval: next });
    await act(async () => oldRequest());
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("keeps provider fallback labels and sends their unchanged decision", async () => {
    render({
      options: [
        {
          decision: "accept",
          label: "Provider allows once",
          warning: "Session grants are unavailable.",
        },
      ],
    });
    await act(async () => button("Provider allows once").click());
    expect(respond).toHaveBeenCalledWith(requestId, "accept");
    expect(host.textContent).not.toContain("Deny");
  });
  it("retains the request and allows retry after a rejected response without claiming execution", async () => {
    respond.mockRejectedValueOnce(new Error("private transport detail"));
    render();
    await act(async () => button("Allow once").click());
    expect(host.textContent).toContain("The request is still pending");
    expect(host.textContent).not.toContain("private transport detail");
    await act(async () => button("Allow once").click());
    expect(respond).toHaveBeenCalledTimes(2);
  });
  it("does not send decisions after connection permission is revoked", async () => {
    render();
    const stale = harness.handlers.get("Allow once")!;
    render({ disabled: true });
    await act(async () => stale());
    expect(respond).not.toHaveBeenCalled();
  });
});
