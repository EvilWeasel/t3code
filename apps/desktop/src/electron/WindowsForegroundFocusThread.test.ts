import { assert, beforeEach, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

const workerConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("node:worker_threads", () => ({
  Worker: function Worker(...args: ReadonlyArray<unknown>) {
    return workerConstructorMock(...args);
  },
}));

import { startWindowsForegroundFocusThread } from "./WindowsForegroundFocusThread.ts";

const makeWorker = () =>
  Object.assign(new NodeEvents.EventEmitter(), {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => 0),
    unref: vi.fn(),
  });

let worker = makeWorker();
const target = {
  windowId: 7,
  processId: 42,
  title: "T3 Code (Dev)",
  bounds: { x: 100, y: 50, width: 1_200, height: 800 },
  contentBounds: { x: 108, y: 50, width: 1_184, height: 792 },
};

beforeEach(() => {
  worker = makeWorker();
  workerConstructorMock.mockReset().mockReturnValue(worker);
});

it("queues focus until the helper is ready", async () => {
  const thread = startWindowsForegroundFocusThread("focus.cjs");
  const focused = thread.focus(target);

  assert.lengthOf(worker.postMessage.mock.calls, 0);
  worker.emit("message", "ready");
  assert.deepEqual(worker.postMessage.mock.calls[0]?.[0], {
    type: "focus",
    requestId: 1,
    target,
  });
  worker.emit("message", { type: "result", requestId: 1, focused: true });

  assert.isTrue(await focused);
  assert.deepEqual(workerConstructorMock.mock.calls, [["focus.cjs"]]);
  thread.close();
});

it("fails pending focus when the helper exits", async () => {
  const replacement = makeWorker();
  workerConstructorMock.mockReturnValueOnce(worker).mockReturnValueOnce(replacement);
  const thread = startWindowsForegroundFocusThread("focus.cjs");
  const focused = thread.focus(target);

  worker.emit("exit", 1);

  assert.isFalse(await focused);
  assert.lengthOf(workerConstructorMock.mock.calls, 1);
  const prepared = thread.prepare(target);
  replacement.emit("message", "ready");
  replacement.emit("message", { type: "result", requestId: 2, focused: true });
  assert.isTrue(await prepared);
  assert.lengthOf(workerConstructorMock.mock.calls, 2);
  thread.close();
});

it("replaces a timed-out helper before accepting more work", async () => {
  vi.useFakeTimers();
  const replacement = makeWorker();
  workerConstructorMock.mockReturnValueOnce(worker).mockReturnValueOnce(replacement);
  const thread = startWindowsForegroundFocusThread("focus.cjs");

  try {
    worker.emit("message", "ready");
    const focused = thread.focus(target);
    await vi.advanceTimersByTimeAsync(1_000);

    assert.isFalse(await focused);
    assert.lengthOf(worker.terminate.mock.calls, 1);
    assert.lengthOf(workerConstructorMock.mock.calls, 2);

    replacement.emit("message", "ready");
    const prepared = thread.prepare(target);
    assert.deepEqual(replacement.postMessage.mock.calls[0]?.[0], {
      type: "prepare",
      requestId: 2,
      target,
    });
    replacement.emit("message", { type: "result", requestId: 2, focused: true });
    assert.isTrue(await prepared);
  } finally {
    thread.close();
    vi.useRealTimers();
  }
});

it.each(["timeout", "error", "close"] as const)("does not retire native work on logical %s before actual exit or termination", async (reason) => {
  vi.useFakeTimers();
  const terminated = Promise.withResolvers<number>();
  worker.terminate.mockImplementation(() => terminated.promise);
  const replacement = makeWorker();
  workerConstructorMock.mockReturnValueOnce(worker).mockReturnValueOnce(replacement);
  const thread = startWindowsForegroundFocusThread("focus.cjs");
  try {
    worker.emit("message", "ready");
    const request = thread.prepare(target);
    let retired = false;
    void request.nativeRetired.then(() => { retired = true; });
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(1_000);
    else if (reason === "error") worker.emit("error", new Error("native helper failed"));
    else thread.close();
    assert.isFalse(await request);
    assert.isFalse(retired);
    if (reason === "error") worker.emit("exit", 1);
    else terminated.resolve(0);
    await request.nativeRetired;
    assert.isTrue(retired);
  } finally { thread.close(); terminated.resolve(0); vi.useRealTimers(); }
});

it("retires an acknowledged request without requiring the pooled worker to exit", async () => {
  const thread = startWindowsForegroundFocusThread("focus.cjs");
  try {
    worker.emit("message", "ready");
    const request = thread.prepare(target);
    worker.emit("message", { type: "result", requestId: 1, focused: true });
    assert.isTrue(await request);
    await request.nativeRetired;
    assert.lengthOf(worker.terminate.mock.calls, 0);
  } finally { thread.close(); }
});

it("does not let an old worker exit retire a new worker's pending request", async () => {
  const old = worker;
  const replacement = makeWorker();
  workerConstructorMock.mockReturnValueOnce(old).mockReturnValueOnce(replacement);
  const thread = startWindowsForegroundFocusThread("focus.cjs");
  try {
    old.emit("message", "ready");
    const first = thread.prepare(target);
    old.emit("error", new Error("reset"));
    assert.isFalse(await first);
    const next = thread.prepare(target);
    let retired = false;
    void next.nativeRetired.then(() => { retired = true; });
    old.emit("exit", 1);
    await first.nativeRetired;
    assert.isFalse(retired);
    replacement.emit("message", "ready");
    replacement.emit("message", { type: "result", requestId: 2, focused: true });
    assert.isTrue(await next);
    await next.nativeRetired;
  } finally { thread.close(); }
});
