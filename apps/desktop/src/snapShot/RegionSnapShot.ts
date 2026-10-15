// @effect-diagnostics globalTimers:off -- Child-process deadlines run outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node child process.
import * as NodeChildProcess from "node:child_process";

import * as Electron from "electron";

import type { ActiveWindow } from "./ActiveWindow.ts";

const CAPTURE_TIMEOUT_MS = 15_000;

export type RegionSnapShotRequest = { readonly region: Electron.Rectangle };
export type RegionSnapShotResult =
  | {
      readonly type: "result";
      readonly width: number;
      readonly height: number;
      readonly png: string;
    }
  | { readonly type: "error"; readonly message: string };

export type RegionSnapShotSource = {
  readonly appIcon?: Electron.NativeImage;
  readonly name: string;
};

export type RegionSnapShotChild = {
  readonly send: (request: RegionSnapShotRequest) => void;
  readonly onMessage: (listener: (message: unknown) => void) => void;
  readonly onExit: (listener: () => void) => void;
  readonly onError?: (listener: () => void) => void;
  readonly kill: () => void;
};

function forkRegionSnapShotChild(workerPath: string): RegionSnapShotChild {
  const child = NodeChildProcess.fork(workerPath, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  return {
    send: (request) => child.send(request),
    onMessage: (listener) => child.on("message", listener),
    onExit: (listener) => {
      child.once("exit", listener);
    },
    onError: (listener) => child.once("error", listener),
    kill: () => child.kill(),
  };
}

export type RegionSnapShotProcess = {
  readonly startupRetired?: Promise<void>;
  readonly exited?: Promise<void>;
  readonly alive: boolean;
  readonly nativeRetired?: Promise<void>;
  readonly capture: (
    region: Electron.Rectangle,
  ) => Promise<{ width: number; height: number; png: Buffer }>;
  readonly close: () => void;
};

/**
 * One capture child. `warm` it ahead of time so the native module is loaded
 * before the shortcut fires; each child serves a single capture and exits.
 */
export function startRegionSnapShotProcess(
  workerPath: string,
  fork: (workerPath: string) => RegionSnapShotChild = forkRegionSnapShotChild,
): RegionSnapShotProcess {
  let child: RegionSnapShotChild;
  try {
    child = fork(workerPath);
  } catch {
    return {
      alive: false,
      nativeRetired: Promise.resolve(),
      startupRetired: Promise.resolve(),
      exited: Promise.resolve(),
      capture: () => Promise.reject(new Error("Windows window capture is unavailable.")),
      close: () => undefined,
    };
  }
  const nativeRetired = Promise.withResolvers<void>();
  const startupRetired = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const result = Promise.withResolvers<{ width: number; height: number; png: Buffer }>();
  let settled = false;
  const finish = (error?: Error, value?: { width: number; height: number; png: Buffer }, acknowledged = false) => {
    if (settled) return;
    settled = true;
    ready.resolve();
    if (value) result.resolve(value);
    else result.reject(error ?? new Error("Windows window capture failed."));
    if (acknowledged) nativeRetired.resolve();
    child.kill();
  };
  child.onMessage((message) => {
    if (message === "ready") {
      startupRetired.resolve();
      ready.resolve();
      return;
    }
    const response = message as RegionSnapShotResult;
    if (response.type === "error") finish(new Error(response.message), undefined, true);
    else if (response.type === "result") {
      finish(undefined, {
        width: response.width,
        height: response.height,
        png: Buffer.from(response.png, "base64"),
      }, true);
    }
  });
  child.onExit(() => { startupRetired.resolve(); exited.resolve(); nativeRetired.resolve(); finish(new Error("Windows window capture helper exited.")); });
  child.onError?.(() => finish(new Error("Windows window capture helper failed.")));
  void result.promise.catch(() => undefined);

  return {
    nativeRetired: nativeRetired.promise,
    startupRetired: startupRetired.promise,
    exited: exited.promise,
    get alive() {
      return !settled;
    },
    capture: async (region) => {
      if (settled) throw new Error("Windows window capture helper already used.");
      const timeout = setTimeout(
        () => finish(new Error("Windows window capture timed out. Try again.")),
        CAPTURE_TIMEOUT_MS,
      );
      timeout.unref();
      try {
        await ready.promise;
        if (settled) return await result.promise;
        child.send({ region });
        return await result.promise;
      } finally {
        clearTimeout(timeout);
      }
    },
    close: () => finish(new Error("Windows window capture cancelled.")),
  };
}

export type RegionSnapShotCapture = {
  readonly result: Promise<{ width: number; height: number; png: Buffer }>;
  readonly nativeRetired: Promise<void>;
};

export type RegionSnapShotPool = {
  readonly warmWithRetirement?: () => Promise<void>;
  readonly coolWithRetirement?: () => Promise<void>;
  readonly captureWithRetirement?: (region: Electron.Rectangle) => RegionSnapShotCapture;
  readonly warm: () => void;
  readonly cool: () => void;
  readonly capture: (
    region: Electron.Rectangle,
  ) => Promise<{ width: number; height: number; png: Buffer }>;
  readonly close: () => void;
};

export function makeRegionSnapShotPool(
  workerPath: string,
  start: (workerPath: string) => RegionSnapShotProcess = startRegionSnapShotProcess,
  observeLifecycle: (start: () => Promise<void>) => Promise<void> = (start) => start(),
): RegionSnapShotPool {
  let standby: RegionSnapShotProcess | undefined;
  let inFlight: RegionSnapShotProcess | undefined;
  let closed = false;
  const closing = new Set<Promise<void>>();
  const unknownRetirement = () => new Promise<void>(() => {});
  const warmWithRetirement = () => {
    if (closed) return Promise.resolve();
    if (standby?.alive) return standby.startupRetired ?? unknownRetirement();
    return observeLifecycle(() => {
      standby = start(workerPath);
      return standby.startupRetired ?? unknownRetirement();
    });
  };
  const coolWithRetirement = () => {
    const current = standby;
    const closingNow = current === undefined ? Promise.resolve() : observeLifecycle(() => {
      standby = undefined;
      const exit = current.exited ?? unknownRetirement();
      closing.add(exit);
      void exit.then(() => closing.delete(exit), () => undefined);
      current.close();
      return exit;
    });
    return Promise.all([...closing, closingNow]).then(() => undefined);
  };
  const warm = () => { void warmWithRetirement().catch(() => undefined); };
  const cool = () => { void coolWithRetirement().catch(() => undefined); };
  const captureWithRetirement = (region: Electron.Rectangle): RegionSnapShotCapture => {
    if (closed || inFlight?.alive) return {
      result: Promise.reject(new Error(closed ? "Windows window capture is unavailable." : "Windows window capture is still in progress. Try again.")),
      nativeRetired: Promise.resolve(),
    };
    const current = standby?.alive ? standby : start(workerPath);
    standby = undefined;
    inFlight = current;
    const result = current.capture(region).finally(() => {
      if (inFlight === current) inFlight = undefined;
      warm();
    });
    return { result, nativeRetired: current.nativeRetired ?? new Promise<void>(() => {}) };
  };
  return {
    warm,
    cool,
    warmWithRetirement,
    coolWithRetirement,
    captureWithRetirement,
    capture: (region) => captureWithRetirement(region).result,
    close: () => {
      closed = true;
      cool();
      inFlight?.close();
    },
  };
}

export async function captureRegionWindowSnapshot(
  pool: Pick<RegionSnapShotPool, "capture" | "captureWithRetirement">,
  active: ActiveWindow,
  region: Electron.Rectangle,
  maxSize: Electron.Size,
  trackNativeRetirement?: (retired: Promise<void>) => void,
): Promise<{ readonly source: RegionSnapShotSource; readonly png: Buffer }> {
  const capture = pool.captureWithRetirement?.(region);
  const result = capture?.result ?? pool.capture(region);
  trackNativeRetirement?.(capture?.nativeRetired ?? new Promise<void>(() => {}));
  const shot = await result;
  const scale = Math.min(maxSize.width / shot.width, maxSize.height / shot.height, 1);
  const png =
    scale < 1
      ? Electron.nativeImage
          .createFromBuffer(shot.png)
          .resize({
            width: Math.max(1, Math.round(shot.width * scale)),
            height: Math.max(1, Math.round(shot.height * scale)),
            quality: "best",
          })
          .toPNG()
      : shot.png;
  return {
    source: {
      name: active.title.trim() || active.owner.name.trim() || "Window",
    },
    png,
  };
}
