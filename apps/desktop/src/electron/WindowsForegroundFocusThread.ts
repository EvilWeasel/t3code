// @effect-diagnostics globalTimers:off -- The helper timeout runs at a worker callback boundary outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node worker.

import * as NodeWorkerThreads from "node:worker_threads";

import type * as Electron from "electron";

const FOCUS_TIMEOUT_MS = 1_000;

export type WindowsForegroundFocusTarget = {
  readonly windowId: number;
  readonly processId: number;
  readonly title: string;
  readonly bounds: Electron.Rectangle;
  readonly contentBounds: Electron.Rectangle;
};

export type WindowsForegroundFocusRequest = Promise<boolean> & { readonly nativeRetired: Promise<void> };

export type WindowsForegroundFocusThread = {
  readonly prepare: (target: WindowsForegroundFocusTarget) => WindowsForegroundFocusRequest;
  readonly focus: (target: WindowsForegroundFocusTarget) => WindowsForegroundFocusRequest;
  readonly close: () => void;
};

type FocusRequest = {
  readonly type: "prepare" | "focus";
  readonly requestId: number;
  readonly target: WindowsForegroundFocusTarget;
};

type FocusResult = {
  readonly type: "result";
  readonly requestId: number;
  readonly focused: boolean;
};

const unavailableThread = (): WindowsForegroundFocusThread => ({
  prepare: () => Object.assign(Promise.resolve(false), { nativeRetired: Promise.resolve() }),
  focus: () => Object.assign(Promise.resolve(false), { nativeRetired: Promise.resolve() }),
  close: () => undefined,
});

export function startWindowsForegroundFocusThread(
  workerPath: string,
): WindowsForegroundFocusThread {
  let worker: NodeWorkerThreads.Worker | undefined;
  let ready = false;
  let closed = false;
  let nextRequestId = 1;
  const retirements = new Map<NodeWorkerThreads.Worker, Set<() => void>>();
  const retireWorker = (retiredWorker: NodeWorkerThreads.Worker) => {
    for (const retire of retirements.get(retiredWorker) ?? []) retire();
    retirements.delete(retiredWorker);
  };
  const terminate = (retiringWorker: NodeWorkerThreads.Worker) => {
    void retiringWorker.terminate().then(() => retireWorker(retiringWorker), () => undefined);
  };
  const pending = new Map<
    number,
    {
      readonly request: FocusRequest;
      readonly resolve: (focused: boolean) => void;
      readonly retire: () => void;
      readonly timeout: ReturnType<typeof setTimeout>;
    }
  >();

  const finish = (requestId: number, focused: boolean, acknowledged = false) => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timeout);
    request.resolve(focused);
    if (acknowledged) request.retire();
  };
  const send = (request: FocusRequest, targetWorker: NodeWorkerThreads.Worker) => {
    if (!ready || closed || worker !== targetWorker) return;
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      targetWorker.postMessage(request);
    } catch {
      finish(request.requestId, false);
    }
  };
  const start = (): boolean => {
    if (closed) return false;
    let nextWorker: NodeWorkerThreads.Worker;
    try {
      nextWorker = new NodeWorkerThreads.Worker(workerPath);
      nextWorker.unref();
    } catch {
      return false;
    }

    worker = nextWorker;
    ready = false;
    const reset = () => {
      if (worker !== nextWorker) return;
      worker = undefined;
      ready = false;
      for (const requestId of pending.keys()) finish(requestId, false);
    };
    nextWorker.on("message", (rawMessage) => {
      if (worker !== nextWorker) return;
      if (rawMessage === "ready") {
        ready = true;
        for (const request of pending.values()) send(request.request, nextWorker);
        return;
      }
      const message = rawMessage as FocusResult;
      if (message.type === "result") finish(message.requestId, message.focused, true);
    });
    nextWorker.once("error", reset);
    nextWorker.once("exit", () => { retireWorker(nextWorker); reset(); });
    return true;
  };

  if (!start()) return unavailableThread();

  const restart = (timedOutWorker: NodeWorkerThreads.Worker | undefined) => {
    if (!timedOutWorker || worker !== timedOutWorker) return;
    worker = undefined;
    ready = false;
    for (const requestId of pending.keys()) finish(requestId, false);
    terminate(timedOutWorker);
    start();
  };
  const request = (type: FocusRequest["type"], target: WindowsForegroundFocusTarget): WindowsForegroundFocusRequest => {
    const nativeRetired = Promise.withResolvers<void>();
    const result = new Promise<boolean>((resolve) => {
      if (closed || (!worker && !start())) {
        resolve(false);
        nativeRetired.resolve();
        return;
      }
      const requestId = nextRequestId++;
      const focusRequest = { type, requestId, target } satisfies FocusRequest;
      const requestWorker = worker!;
      const timeout = setTimeout(() => {
        finish(requestId, false);
        restart(requestWorker);
      }, FOCUS_TIMEOUT_MS);
      timeout.unref();
      let retired = false;
      const retire = () => {
        if (retired) return;
        retired = true;
        retirements.get(requestWorker)?.delete(retire);
        nativeRetired.resolve();
      };
      const workerRetirements = retirements.get(requestWorker) ?? new Set<() => void>();
      workerRetirements.add(retire);
      retirements.set(requestWorker, workerRetirements);
      pending.set(requestId, { request: focusRequest, resolve, retire, timeout });
      send(focusRequest, requestWorker);
    });
    return Object.assign(result, { nativeRetired: nativeRetired.promise });
  };

  return {
    prepare: (target) => request("prepare", target),
    focus: (target) => request("focus", target),
    close: () => {
      if (closed) return;
      closed = true;
      const activeWorker = worker;
      worker = undefined;
      ready = false;
      for (const requestId of pending.keys()) finish(requestId, false);
      if (activeWorker) terminate(activeWorker);
    },
  };
}
