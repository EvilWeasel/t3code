// @vitest-environment jsdom

import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { importComposerThreadAttachment } from "./composerThreadImport";
import { THREAD_CONTEXT_DROP_EVENT, useThreadContextDrop } from "./threadContextDrag";

type OnDrop = Parameters<typeof useThreadContextDrop>[3];
type ProbeProps = {
  targetRef: RefObject<EventTarget | null>;
  environmentId: EnvironmentId;
  targetKey: string;
  onDrop: OnDrop;
};
type Drop = { refs: ReadonlyArray<ScopedThreadRef>; isActive: () => boolean };

const environment = EnvironmentId.make("destination");
const refs: ReadonlyArray<ScopedThreadRef> = [
  { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("source-thread") },
];
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

function Probe({ targetRef, environmentId, targetKey, onDrop }: ProbeProps) {
  useThreadContextDrop(targetRef, environmentId, targetKey, onDrop);
  return null;
}

function refTo(target: EventTarget) {
  const ref = createRef<EventTarget>();
  ref.current = target;
  return ref;
}

async function render(props: ProbeProps) {
  await act(async () => root.render(<Probe {...props} />));
}

async function drop(target: EventTarget) {
  await act(async () => {
    target.dispatchEvent(
      new CustomEvent<ReadonlyArray<ScopedThreadRef>>(THREAD_CONTEXT_DROP_EVENT, { detail: refs }),
    );
  });
}

function lastDrop(drops: Drop[]) {
  const result = drops.at(-1);
  if (!result) throw new Error("Expected a handled thread drop");
  return result;
}

function deferred<T>() {
  const completion: { resolve?: (value: T | PromiseLike<T>) => void } = {};
  const promise = new Promise<T>((resolve) => {
    completion.resolve = resolve;
  });
  const resolve = completion.resolve;
  if (resolve === undefined) throw new Error("Deferred resolver was not initialized");
  return { promise, resolve };
}

describe("useThreadContextDrop", () => {
  it("uses the latest committed callback without retiring an existing non-target render's binding", async () => {
    const target = document.createElement("div");
    const drops: Drop[] = [];
    const labels: string[] = [];
    const onDrop =
      (label: string): OnDrop =>
      (received, isActive) => {
        labels.push(label);
        drops.push({ refs: received, isActive });
      };
    const props = {
      targetRef: refTo(target),
      environmentId: environment,
      targetKey: "draft",
      onDrop: onDrop("first"),
    };
    await render(props);
    await drop(target);
    const original = lastDrop(drops);
    expect(original.refs).toBe(refs);
    expect(original.isActive()).toBe(true);

    await render({ ...props, onDrop: onDrop("committed replacement") });
    expect(original.isActive()).toBe(true);
    await drop(target);
    expect(labels).toEqual(["first", "committed replacement"]);
    expect(drops).toHaveLength(2);
    expect(lastDrop(drops).refs).toBe(refs);
    expect(lastDrop(drops).isActive()).toBe(true);
    expect(original.isActive()).toBe(true);
  });

  it.each(["environment", "target-key"])(
    "permanently retires old eligibility after a %s switch away and back",
    async (change) => {
      const target = document.createElement("div");
      const drops: Drop[] = [];
      const props = {
        targetRef: refTo(target),
        environmentId: environment,
        targetKey: "original",
        onDrop: (received: ReadonlyArray<ScopedThreadRef>, isActive: () => boolean) => {
          drops.push({ refs: received, isActive });
        },
      };
      await render(props);
      await drop(target);
      const original = lastDrop(drops);
      await render({
        ...props,
        ...(change === "environment"
          ? { environmentId: EnvironmentId.make("replacement-environment") }
          : { targetKey: "replacement" }),
      });
      expect(original.isActive()).toBe(false);
      await drop(target);
      const away = lastDrop(drops);
      expect(away.isActive()).toBe(true);

      await render(props);
      expect(original.isActive()).toBe(false);
      expect(away.isActive()).toBe(false);
      await drop(target);
      expect(drops).toHaveLength(3);
      expect(lastDrop(drops).isActive()).toBe(true);
      expect(original.isActive()).toBe(false);
    },
  );

  it("removes the listener and retires captured eligibility when its component unmounts", async () => {
    const target = document.createElement("div");
    const drops: Drop[] = [];
    await render({
      targetRef: refTo(target),
      environmentId: environment,
      targetKey: "draft",
      onDrop: (received, isActive) => drops.push({ refs: received, isActive }),
    });
    await drop(target);
    const original = lastDrop(drops);
    await act(async () => root.render(null));
    expect(original.isActive()).toBe(false);
    await drop(target);
    expect(drops).toHaveLength(1);
  });

  it("detaches and reattaches listeners when the ref object's identity changes", async () => {
    const firstTarget = document.createElement("div");
    const secondTarget = document.createElement("div");
    const firstRef = refTo(firstTarget);
    const secondRef = refTo(secondTarget);
    const drops: Drop[] = [];
    const props = {
      targetRef: firstRef,
      environmentId: environment,
      targetKey: "draft",
      onDrop: (received: ReadonlyArray<ScopedThreadRef>, isActive: () => boolean) => {
        drops.push({ refs: received, isActive });
      },
    };
    await render(props);
    await drop(firstTarget);
    const original = lastDrop(drops);
    await render({ ...props, targetRef: secondRef });
    expect(original.isActive()).toBe(false);
    await drop(firstTarget);
    expect(drops).toHaveLength(1);
    await drop(secondTarget);
    const second = lastDrop(drops);
    expect(second.isActive()).toBe(true);

    await render(props);
    expect(original.isActive()).toBe(false);
    expect(second.isActive()).toBe(false);
    await drop(secondTarget);
    expect(drops).toHaveLength(2);
    await drop(firstTarget);
    expect(drops).toHaveLength(3);
    expect(lastDrop(drops).isActive()).toBe(true);
  });

  it.each(["environment", "target-key"])(
    "blocks the old deferred import after a %s roundtrip while allowing the fresh binding's import",
    async (change) => {
      const target = document.createElement("div");
      const oldLoad = deferred<File>();
      const freshLoad = deferred<File>();
      const pendingImports = new Map([
        ["original", 1],
        ["replacement", 2],
      ]);
      const imports: Array<Promise<void>> = [];
      const attachments: Array<{ targetKey: string; file: File }> = [];
      const onDrop =
        (load: Promise<File>): OnDrop =>
        (_received, isActive) => {
          const targetKey = "original";
          imports.push(
            importComposerThreadAttachment({
              targetKey,
              pendingImports,
              countReservedAttachments: () => pendingImports.get(targetKey) ?? 0,
              load: () => load,
              isActive,
              attach: async (file) => {
                attachments.push({ targetKey, file });
                return true;
              },
              onLimitReached: () => {
                throw new Error("The synthetic import should have capacity");
              },
            }),
          );
        };
      const props = {
        targetRef: refTo(target),
        environmentId: environment,
        targetKey: "original",
        onDrop: onDrop(oldLoad.promise),
      };
      await render(props);
      await drop(target);
      const oldImport = imports[0];
      if (!oldImport) throw new Error("Original drop did not start its import");
      expect(pendingImports.get("original")).toBe(2);

      await render({
        ...props,
        ...(change === "environment"
          ? { environmentId: EnvironmentId.make("replacement-environment") }
          : { targetKey: "replacement" }),
      });
      await render({ ...props, onDrop: onDrop(freshLoad.promise) });
      await drop(target);
      const freshImport = imports[1];
      if (!freshImport) throw new Error("Fresh drop did not start its import");
      expect(pendingImports.get("original")).toBe(3);

      const freshFile = new File(["fresh"], "fresh.jsonl");
      freshLoad.resolve(freshFile);
      await freshImport;
      expect(attachments).toEqual([{ targetKey: "original", file: freshFile }]);
      expect(pendingImports.get("original")).toBe(2);

      oldLoad.resolve(new File(["stale"], "stale.jsonl"));
      await oldImport;
      expect(imports).toHaveLength(2);
      expect(attachments).toEqual([{ targetKey: "original", file: freshFile }]);
      expect([...pendingImports]).toEqual([
        ["original", 1],
        ["replacement", 2],
      ]);
    },
  );
});
