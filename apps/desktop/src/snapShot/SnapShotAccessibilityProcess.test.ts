import { assert, beforeEach, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import * as NodeProcess from "node:process";
import { vi } from "vite-plus/test";

const forkMock = vi.hoisted(() =>
  vi.fn<
    (
      _path: string,
      _args: ReadonlyArray<string>,
      _options: { env?: NodeJS.ProcessEnv; execPath?: string },
    ) => unknown
  >(),
);

vi.mock("node:child_process", () => ({ fork: forkMock }));

import {
  makeSnapShotAccessibilityProcessPool,
  startSnapShotAccessibilityProcess,
} from "./SnapShotAccessibilityProcess.ts";

const makeWorker = () =>
  Object.assign(new NodeEvents.EventEmitter(), {
    kill: vi.fn(() => true),
    send: vi.fn(),
  });
let worker = makeWorker();
const request = {
  active: {
    title: "Zoom Meeting",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: { processId: 42 },
  },
  platform: "darwin" as const,
  sourceTitle: "Zoom Meeting",
  imageSize: { width: 1_600, height: 1_200 },
};

beforeEach(() => {
  worker = makeWorker();
  forkMock.mockReset().mockReturnValue(worker);
});

it("keeps T3 alive when Zoom crashes accessibility extraction", async () => {
  const process = startSnapShotAccessibilityProcess("accessibility.cjs");
  const read = process.read(request);
  worker.emit("message", "ready");
  worker.emit("message", "started");
  await read.started;
  worker.emit("exit", null, "SIGABRT");

  assert.isUndefined(await read.result);
});

it("returns immediately when accessibility crashes before the screenshot is ready", async () => {
  const process = startSnapShotAccessibilityProcess("accessibility.cjs");
  worker.emit("exit", null, "SIGABRT");

  const read = process.read(request);
  await read.started;
  assert.isUndefined(await read.result);
});

it("returns accessibility extracted by the helper", async () => {
  const process = startSnapShotAccessibilityProcess("accessibility.cjs");
  const read = process.read(request);
  const context = { accessibleText: "Meeting controls" };
  worker.emit("message", "ready");
  worker.emit("message", "started");
  worker.emit("message", { type: "result", context });

  await read.started;
  assert.deepEqual(await read.result, context);
  assert.strictEqual(forkMock.mock.calls[0]?.[2]?.env?.ELECTRON_RUN_AS_NODE, "1");
  assert.strictEqual(forkMock.mock.calls[0]?.[2]?.execPath, NodeProcess.execPath);
});

it("hands a warm helper to the capture and prewarms its replacement", async () => {
  const warmWorker = makeWorker();
  const replacementWorker = makeWorker();
  forkMock.mockReset().mockReturnValueOnce(warmWorker).mockReturnValueOnce(replacementWorker);
  const pool = makeSnapShotAccessibilityProcessPool("accessibility.cjs");

  pool.warm();
  warmWorker.emit("message", "ready");
  const read = pool.read(request);

  assert.lengthOf(forkMock.mock.calls, 2);
  assert.deepEqual(warmWorker.send.mock.calls[0]?.[0], request);
  assert.lengthOf(replacementWorker.send.mock.calls, 0);

  warmWorker.emit("message", "started");
  warmWorker.emit("message", { type: "result", context: { accessibleText: "Ready" } });
  assert.deepEqual(await read.result, { accessibleText: "Ready" });

  pool.close();
  assert.lengthOf(replacementWorker.kill.mock.calls, 1);
});

it("replaces a warm helper that exits before capture", async () => {
  const exitedWorker = makeWorker();
  const captureWorker = makeWorker();
  const replacementWorker = makeWorker();
  forkMock
    .mockReset()
    .mockReturnValueOnce(exitedWorker)
    .mockReturnValueOnce(captureWorker)
    .mockReturnValueOnce(replacementWorker);
  const pool = makeSnapShotAccessibilityProcessPool("accessibility.cjs");

  pool.warm();
  exitedWorker.emit("exit", 1);
  const read = pool.read(request);
  captureWorker.emit("message", "ready");
  captureWorker.emit("message", "started");
  captureWorker.emit("message", { type: "result", context: { accessibleText: "Recovered" } });

  assert.deepEqual(await read.result, { accessibleText: "Recovered" });
  assert.lengthOf(forkMock.mock.calls, 3);
  assert.deepEqual(captureWorker.send.mock.calls[0]?.[0], request);
  pool.close();
});

it("allows cold startup to exceed the request-start budget", async () => {
  vi.useFakeTimers();
  const process = startSnapShotAccessibilityProcess("accessibility.cjs");
  try {
    const read = process.read(request);
    await vi.advanceTimersByTimeAsync(1_500);
    assert.lengthOf(worker.kill.mock.calls, 0);
    worker.emit("message", "ready");
    assert.deepEqual(worker.send.mock.calls[0]?.[0], request);
    worker.emit("message", "started");
    worker.emit("message", { type: "result", context: { accessibleText: "Ready" } });
    assert.deepEqual(await read.result, { accessibleText: "Ready" });
  } finally {
    process.close();
    vi.useRealTimers();
  }
});

it("keeps timeout retirement pending after kill while the native child has not exited", async () => {
  vi.useFakeTimers();
  const process = startSnapShotAccessibilityProcess("accessibility.cjs");
  try {
    const read = process.read(request);
    let retired = false;
    void read.nativeRetired!.then(() => { retired = true; });
    worker.emit("message", "ready");
    worker.emit("message", "started");
    await vi.advanceTimersByTimeAsync(4_000);
    assert.isUndefined(await read.result);
    assert.lengthOf(worker.kill.mock.calls, 1);
    assert.isFalse(retired);
    worker.emit("exit", 0);
    await read.nativeRetired;
    assert.isTrue(retired);
  } finally { process.close(); worker.emit("exit", 0); vi.useRealTimers(); }
});

it("keeps even an accessibility result separate from actual child retirement", async () => {
  const process = startSnapShotAccessibilityProcess("accessibility.cjs");
  const read = process.read(request);
  worker.emit("message", "ready");
  worker.emit("message", "started");
  worker.emit("message", { type: "result", context: { accessibleText: "owned fixture" } });
  await read.result;
  let retired = false;
  void read.nativeRetired!.then(() => { retired = true; });
  await Promise.resolve();
  assert.isFalse(retired);
  worker.emit("exit", 0);
  await read.nativeRetired;
  process.close();
});

it("retains admission after the real reader's inner timeout result while native read and child exit are withheld", async () => {
  const { readAccessibleWindowContextWithApp } = await import("./SnapShotAccessibility.ts");
  const { makeRendererCreationAdmission } = await import("../electron/ElectronWindow.ts");
  vi.useFakeTimers();
  const native = Promise.withResolvers<{ value: string; children: never[] }>();
  const nativeStarted = Promise.withResolvers<void>();
  const window = {
    role: "window", name: request.active.title, bounds: request.active.bounds,
    tree: () => { nativeStarted.resolve(); return native.promise; },
    children: async () => [],
  };
  const App = {
    byPid: async () => ({ children: async () => [window] }),
    list: async () => [],
  } as unknown as Parameters<typeof readAccessibleWindowContextWithApp>[0];
  const gate = makeRendererCreationAdmission(() => 100, () => []);
  const activity = gate.tryReserveRuntimeActivity({ kind: "snapshot-capture" });
  const process = startSnapShotAccessibilityProcess("accessibility.cjs");
  try {
    const read = process.read(request);
    void read.nativeRetired!.then(() => activity!.release());
    worker.emit("message", "ready");
    const logical = readAccessibleWindowContextWithApp(App, request, () => worker.emit("message", "started"));
    await nativeStarted.promise;
    await read.started;
    await vi.advanceTimersByTimeAsync(3_000);
    // This is exactly the real worker's forwarding seam: its result need not
    // mean the reader's already-started native tree() call has completed.
    worker.emit("message", { type: "result", context: await logical });
    await read.result;
    assert.lengthOf(worker.kill.mock.calls, 1);
    assert.isUndefined(gate.acquire(200));
    worker.emit("exit", 0);
    await read.nativeRetired;
    const held = gate.acquire(200);
    assert.isDefined(held);
    held!.release();
  } finally {
    native.resolve({ value: "completed", children: [] });
    worker.emit("exit", 0);
    process.close();
    vi.useRealTimers();
  }
});
