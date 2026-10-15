import {
  MainRendererDiagnosticsInvalidation,
  MainRendererDiagnosticsResponse,
  type MainRendererDiagnosticsReadInput,
  type MainRendererDiagnosticsReadResult,
  type MainRendererDiagnosticsRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

const sameRequest = Schema.toEquivalence(MainRendererDiagnosticsResponse.fields.binding);
const sameTarget = Schema.toEquivalence(
  MainRendererDiagnosticsResponse.fields.binding.fields.target,
);
const unavailable = (
  reason: Extract<MainRendererDiagnosticsReadResult, { status: "unavailable" }>["reason"],
): MainRendererDiagnosticsReadResult => ({ status: "unavailable", reason });

export class MainRendererDiagnostics extends Context.Service<
  MainRendererDiagnostics,
  {
    readonly read: (
      source: string,
      alive: () => boolean,
      input: MainRendererDiagnosticsReadInput,
    ) => Effect.Effect<MainRendererDiagnosticsReadResult>;
    readonly cancelSource: (source: string) => Effect.Effect<void>;
    readonly respond: (
      response: MainRendererDiagnosticsResponse,
      event?: DesktopIpc.DesktopIpcInvokeEvent,
    ) => Effect.Effect<boolean>;
    readonly invalidate: (
      input: MainRendererDiagnosticsInvalidation,
      event?: DesktopIpc.DesktopIpcInvokeEvent,
    ) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/ipc/methods/mainRendererDiagnostics") {}

type Pending = {
  readonly source: string;
  readonly request: MainRendererDiagnosticsRequest;
  readonly window: Electron.BrowserWindow;
  readonly alive: () => boolean;
  readonly deferred: Deferred.Deferred<MainRendererDiagnosticsReadResult>;
  readonly startedAtMs: number;
  replied: boolean;
  invalidated: boolean;
};

/** One opt-in request, one transient response; no history or unsolicited sampler. */
export const make = Effect.fn("desktop.mainRendererDiagnostics.make")(function* () {
  const windows = yield* ElectronWindow.ElectronWindow;
  const app = yield* ElectronApp.ElectronApp;
  const crypto = yield* Crypto.Crypto;
  const sessionNonce = yield* crypto.randomUUIDv4.pipe(Effect.option);
  let generation = 0;
  let requestSequence = 0;
  let pending: Pending | undefined;
  let cache: Extract<MainRendererDiagnosticsReadResult, { status: "ready" }> | undefined;
  const stop = (
    reason: Extract<MainRendererDiagnosticsReadResult, { status: "unavailable" }>["reason"],
    expected?: Pending,
  ) => {
    if (expected !== undefined && pending !== expected) return;
    cache = undefined;
    if (pending) {
      pending.replied = true;
      pending.invalidated = true;
      Deferred.doneUnsafe(pending.deferred, Effect.succeed(unavailable(reason)));
    }
  };
  const matchesNative = (p: Pending, event?: DesktopIpc.DesktopIpcInvokeEvent) => {
    try {
      const wc = p.window.webContents;
      if (p.invalidated || !p.alive() || p.window.isDestroyed() || wc.isDestroyed()) return false;
      const f = wc.mainFrame;
      if (
        f.processId !== p.request.frameProcessId ||
        f.routingId !== p.request.frameRoutingId ||
        p.request.navigationGeneration !== generation
      )
        return false;
      return (
        event === undefined ||
        (event.sender.id === wc.id &&
          event.senderFrame?.parent === null &&
          event.senderFrame.processId === f.processId &&
          event.senderFrame.routingId === f.routingId)
      );
    } catch {
      return false;
    }
  };
  const isCurrentMain = (p: Pending) =>
    windows.main.pipe(Effect.map((main) => Option.isSome(main) && main.value === p.window));

  let trackedWindow: Electron.BrowserWindow | undefined;
  let unwatch: (() => void) | undefined;
  const watch = (window: Electron.BrowserWindow) => {
    if (trackedWindow === window) return;
    unwatch?.();
    trackedWindow = window;
    generation++;
    const wc = window.webContents;
    const invalidate = () => {
      if (trackedWindow !== window) return;
      generation++;
      stop("context-changed");
    };
    const navigation = (
      _event: Electron.Event,
      _url: string,
      _inPlace: boolean,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame) invalidate();
    };
    wc.on("did-start-navigation", navigation);
    wc.on("render-process-gone", invalidate);
    wc.on("destroyed", invalidate);
    unwatch = () => {
      wc.removeListener("did-start-navigation", navigation);
      wc.removeListener("render-process-gone", invalidate);
      wc.removeListener("destroyed", invalidate);
    };
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unwatch?.();
      trackedWindow = undefined;
      stop("context-changed");
    }),
  );

  return MainRendererDiagnostics.of({
    read: (source, alive, input) =>
      Effect.gen(function* () {
        const startedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (Option.isNone(sessionNonce)) return unavailable("unsupported");
        if (input.expiresAtMs <= startedAtMs || input.expiresAtMs - startedAtMs > 5_000)
          return unavailable("expired");
        if (!alive()) return unavailable("source-closed");
        if (pending) return unavailable("busy");
        const main = yield* windows.main;
        if (Option.isNone(main) || main.value.isDestroyed() || main.value.webContents.isDestroyed())
          return unavailable("not-main");
        const metadata = yield* app.metadata.pipe(Effect.option);
        if (Option.isNone(metadata)) return unavailable("unsupported");
        const nonce = yield* crypto.randomUUIDv4.pipe(Effect.option);
        if (Option.isNone(nonce)) return unavailable("unsupported");
        const requestNonce = nonce.value;
        const deferred = yield* Deferred.make<MainRendererDiagnosticsReadResult>();
        if (pending || !alive()) return unavailable("busy");
        const window = main.value;
        watch(window);
        const frame = window.webContents.mainFrame;
        if (requestSequence >= Number.MAX_SAFE_INTEGER) return unavailable("unsupported");
        const request: MainRendererDiagnosticsRequest = {
          version: 1,
          requestSequence: ++requestSequence,
          requestId: input.requestId,
          requestNonce,
          target: input.target,
          mainSession: sessionNonce.value,
          windowId: window.id,
          frameProcessId: frame.processId,
          frameRoutingId: frame.routingId,
          navigationGeneration: generation,
          expiresAtMs: Math.min(input.expiresAtMs, startedAtMs + 2_000),
        };
        const p: Pending = {
          source,
          request,
          window,
          alive,
          deferred,
          startedAtMs,
          replied: false,
          invalidated: false,
        };
        pending = p;
        const wc = window.webContents;
        return yield* Effect.gen(function* () {
          if (!(yield* isCurrentMain(p)) || !matchesNative(p)) return unavailable("not-main");
          const sent = yield* Effect.try({
            try: () => wc.send(Channels.MAIN_RENDERER_DIAGNOSTICS_REQUEST_CHANNEL, request),
            catch: () => "unavailable" as const,
          }).pipe(Effect.option);
          if (Option.isNone(sent)) return unavailable("context-changed");
          const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption("2 seconds"));
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          if (now < startedAtMs) return unavailable("clock-anomaly");
          if (now >= request.expiresAtMs) return unavailable("expired");
          if (!(yield* isCurrentMain(p)) || !matchesNative(p))
            return unavailable("context-changed");
          if (Option.isNone(result)) return unavailable("timeout");
          if (result.value.status === "ready" && cache?.response !== result.value.response)
            return unavailable("context-changed");
          return result.value;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (pending === p) {
                pending = undefined;
                cache = undefined;
              }
            }),
          ),
        );
      }),
    cancelSource: (source) =>
      Effect.sync(() => {
        if (pending?.source === source) stop("source-closed");
      }),
    respond: (response, event) =>
      Effect.gen(function* () {
        const p = pending;
        if (
          !p ||
          !event ||
          p.replied ||
          !sameRequest(response.binding, p.request) ||
          !matchesNative(p, event) ||
          !(yield* isCurrentMain(p)) ||
          pending !== p
        )
          return false;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if (now < p.startedAtMs || now >= p.request.expiresAtMs) {
          stop("expired", p);
          return false;
        }
        p.replied = true;
        if (response.result.status !== "ready") {
          stop("context-changed", p);
          return true;
        }
        const gate = response.result.gate;
        if (!sameTarget(gate, p.request.target)) {
          stop("target-mismatch", p);
          return false;
        }
        const metadata = yield* app.metadata.pipe(Effect.option);
        if (Option.isNone(metadata) || pending !== p || !matchesNative(p, event)) {
          stop("context-changed", p);
          return false;
        }
        cache = {
          status: "ready",
          response,
          appVersion: metadata.value.appVersion,
          observedAtMs: now,
          expiresAtMs: p.request.expiresAtMs,
        };
        yield* Deferred.succeed(p.deferred, cache);
        return true;
      }),
    invalidate: (input, event) =>
      Effect.gen(function* () {
        const p = pending;
        if (
          !p ||
          !event ||
          !sameRequest(input.binding, p.request) ||
          !matchesNative(p, event) ||
          !(yield* isCurrentMain(p)) ||
          pending !== p
        )
          return false;
        if (
          cache &&
          (input.rendererEpoch !== cache.response.rendererEpoch ||
            input.revision !== cache.response.revision)
        )
          return false;
        stop("context-changed", p);
        return true;
      }),
  });
});
export const layer = Layer.effect(MainRendererDiagnostics, make());
export const respond = DesktopIpc.makeIpcMethod({
  channel: Channels.MAIN_RENDERER_DIAGNOSTICS_RESPONSE_CHANNEL,
  payload: MainRendererDiagnosticsResponse,
  result: Schema.Boolean,
  handler: (input, event) =>
    Effect.flatMap(MainRendererDiagnostics, (service) => service.respond(input, event)),
});
export const invalidate = DesktopIpc.makeIpcMethod({
  channel: Channels.MAIN_RENDERER_DIAGNOSTICS_INVALIDATE_CHANNEL,
  payload: MainRendererDiagnosticsInvalidation,
  result: Schema.Boolean,
  handler: (input, event) =>
    Effect.flatMap(MainRendererDiagnostics, (service) => service.invalidate(input, event)),
});
