// @vitest-environment jsdom

import { act, startTransition, Suspense, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useStableCallback } from "./useStableCallback";

type Callback = (value: string, count: number) => string;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(): HTMLButtonElement {
  const element = container.querySelector("button");
  if (!element) throw new Error("Missing callback probe button");
  return element;
}

function Probe({
  label,
  committed,
  events,
  renderAttempts,
  pause,
}: {
  label: string;
  committed: Callback[];
  events: string[];
  renderAttempts?: string[];
  pause?: Promise<void>;
}) {
  const callback = useStableCallback(
    (value: string, count: number) => `${label}:${value.repeat(count)}`,
  );
  useLayoutEffect(() => {
    committed.push(callback);
  });
  renderAttempts?.push(label);
  if (pause) throw pause;
  return <button onClick={() => events.push(callback("event", 2))}>{label}</button>;
}

describe("useStableCallback", () => {
  it("retains identity across commits while the next event uses the latest committed props", async () => {
    const committed: Callback[] = [];
    const events: string[] = [];
    await act(async () =>
      root.render(<Probe label="first" committed={committed} events={events} />),
    );
    const first = committed[0];
    if (!first) throw new Error("Initial callback was not committed");
    expect(first("input", 2)).toBe("first:inputinput");
    await act(async () => button().click());

    for (const label of ["second", "third"]) {
      await act(async () =>
        root.render(<Probe label={label} committed={committed} events={events} />),
      );
      expect(committed.at(-1)).toBe(first);
      expect(first("input", 1)).toBe(`${label}:input`);
      await act(async () => button().click());
    }

    expect(committed).toHaveLength(3);
    expect(events).toEqual(["first:eventevent", "second:eventevent", "third:eventevent"]);
  });

  it("does not expose a suspended render's callback before commit or after that render is abandoned", async () => {
    const committed: Callback[] = [];
    const events: string[] = [];
    const renderAttempts: string[] = [];
    const suspended = Promise.withResolvers<void>();
    const tree = (label: string, pause?: Promise<void>) => (
      <Suspense fallback={<span>Pending</span>}>
        <Probe
          label={label}
          committed={committed}
          events={events}
          renderAttempts={renderAttempts}
          {...(pause ? { pause } : {})}
        />
      </Suspense>
    );
    await act(async () => root.render(tree("committed")));
    const first = committed[0];
    if (!first) throw new Error("Initial callback was not committed");

    await act(async () => {
      startTransition(() => root.render(tree("uncommitted", suspended.promise)));
    });
    expect(renderAttempts).toContain("uncommitted");
    expect(committed).toHaveLength(1);
    expect(button().textContent).toBe("committed");
    expect(first("input", 1)).toBe("committed:input");
    await act(async () => button().click());
    expect(events).toEqual(["committed:eventevent"]);

    await act(async () => root.render(tree("replacement")));
    expect(committed.at(-1)).toBe(first);
    expect(first("input", 1)).toBe("replacement:input");
    await act(async () => {
      suspended.resolve();
    });
    await act(async () => button().click());
    expect(events).toEqual(["committed:eventevent", "replacement:eventevent"]);
    expect(first("input", 1)).toBe("replacement:input");
  });

  it("keeps a deferred invocation on its original callback after a new callback commits", async () => {
    const original = Promise.withResolvers<string>();
    const replacement = Promise.withResolvers<string>();
    const started: string[] = [];
    const pending: Array<Promise<{ label: string; argument: number; result: string }>> = [];
    const committed: Array<(argument: number) => (typeof pending)[number]> = [];
    function AsyncProbe({ label, gate }: { label: string; gate: Promise<string> }) {
      const callback = useStableCallback(async (argument: number) => {
        started.push(label);
        const result = await gate;
        return { label, argument, result };
      });
      useLayoutEffect(() => {
        committed.push(callback);
      });
      return <button onClick={() => pending.push(callback(pending.length + 1))}>{label}</button>;
    }
    await act(async () => root.render(<AsyncProbe label="original" gate={original.promise} />));
    await act(async () => button().click());
    expect(started).toEqual(["original"]);

    await act(async () =>
      root.render(<AsyncProbe label="replacement" gate={replacement.promise} />),
    );
    expect(committed[1]).toBe(committed[0]);
    await act(async () => button().click());
    expect(started).toEqual(["original", "replacement"]);
    expect(pending).toHaveLength(2);

    replacement.resolve("new result");
    await expect(pending[1]).resolves.toEqual({
      label: "replacement",
      argument: 2,
      result: "new result",
    });
    original.resolve("old result");
    await expect(pending[0]).resolves.toEqual({
      label: "original",
      argument: 1,
      result: "old result",
    });
  });
});
