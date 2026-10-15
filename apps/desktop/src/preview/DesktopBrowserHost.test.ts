// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

/** A tab's webContents and debugger, with the debugger's commands left pending until released. */
const makeDebuggee = () => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const sent: string[] = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string) =>
      new Promise((resolve) => {
        sent.push(method);
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        pending.push(() => resolve({ method }));
      }),
  });
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
  };
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    sent,
  };
};

/** Reads `count` events from one backend's subscription. */
const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

const connect = Effect.fn(function* (host: DesktopBrowserHost.DesktopBrowserHost["Service"]) {
  const connection = host.createConnection();
  const messages = yield* Queue.unbounded<typeof DesktopBrowserEvent.Type>();
  yield* connection.events.pipe(
    Stream.runForEach((line) => Queue.offer(messages, decodeEvent(new TextDecoder().decode(line)))),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  return { connection, messages };
});
const grant = Effect.fn(function* (
  host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  backend: {
    connection: DesktopBrowserHost.DesktopBrowserConnection;
    messages: Queue.Queue<typeof DesktopBrowserEvent.Type>;
  },
  source: Electron.WebContents,
) {
  const acquiring = yield* Effect.tryPromise(() => host.acquirePrivateEntry(source)).pipe(
    Effect.forkScoped,
  );
  const request = yield* Queue.take(backend.messages);
  if (request.type !== "private-entry-acquire") throw new Error("Expected acquire");
  const response = {
    ...request,
    type: "private-entry-granted",
    leaseId: "owned-lease",
    generation: 7,
  };
  yield* backend.connection.handleCommandLine(encodeJson(response));
  return { lease: yield* Fiber.join(acquiring), request, response };
});

describe("DesktopBrowserHost", () => {
  it.effect("refuses unknown/unattached authority without sending an acquire", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      expect(host.canRequestPrivateEntry(debuggee.tab.webContents)).toBe(false);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Effect.tryPromise(() => host.acquirePrivateEntry(debuggee.tab.webContents)),
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect(
    "processes matching release ACK while private and rejects wrong request/generation",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const backend = yield* connect(host);
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        yield* Queue.take(backend.messages);
        const { lease } = yield* grant(host, backend, debuggee.tab.webContents);
        host.setPrivateEntry(debuggee.tab.webContents, true);
        const releasing = yield* Effect.tryPromise(() => lease.release()).pipe(Effect.forkScoped);
        const request = yield* Queue.take(backend.messages);
        if (request.type !== "private-entry-release") throw new Error("Expected release");
        yield* backend.connection.handleCommandLine(
          encodeJson({ ...request, type: "private-entry-released", generation: 8 }),
        );
        yield* backend.connection.handleCommandLine(
          encodeJson({ ...request, type: "private-entry-released", requestId: "wrong" }),
        );
        expect(lease.current()).toBe(true);
        expect(releasing.pollUnsafe()).toBeUndefined();
        yield* backend.connection.handleCommandLine(
          encodeJson({ ...request, type: "private-entry-released" }),
        );
        yield* Fiber.join(releasing);
        expect(lease.current()).toBe(false);
        // ACK alone never opens privacy; only Manager's verified clear can do so.
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "command half-close invalidates a grant while input consumer lives and old close cannot invalidate replacement",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const old = yield* connect(host);
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        yield* Queue.take(old.messages);
        const first = yield* grant(host, old, debuggee.tab.webContents);
        host.setPrivateEntry(debuggee.tab.webContents, true);
        yield* old.connection.closed;
        expect(first.lease.current()).toBe(false);
        expect(host.canRequestPrivateEntry(debuggee.tab.webContents)).toBe(false);
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
        expect(
          Exit.isFailure(yield* Effect.exit(Effect.tryPromise(() => first.lease.release()))),
        ).toBe(true);
        const current = yield* connect(host);
        const attached = yield* Queue.take(current.messages);
        expect(attached.type).toBe("attached");
        expect(host.canRequestPrivateEntry(debuggee.tab.webContents)).toBe(true);
        yield* old.connection.closed;
        yield* old.connection.handleCommandLine(encodeJson(first.response));
        expect(host.canRequestPrivateEntry(debuggee.tab.webContents)).toBe(true);
        expect(first.lease.current()).toBe(false);
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "revokes the original acquisition while private and ignores stale attachment results",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const backend = yield* connect(host);
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        yield* Queue.take(backend.messages);
        const acquired = yield* grant(host, backend, debuggee.tab.webContents);
        host.setPrivateEntry(debuggee.tab.webContents, true);
        yield* backend.connection.handleCommandLine(
          encodeJson({
            ...acquired.response,
            type: "private-entry-revoked",
            reason: "control-changed",
            attachmentId: "stale",
          }),
        );
        expect(acquired.lease.current()).toBe(true);
        yield* backend.connection.handleCommandLine(
          encodeJson({
            ...acquired.response,
            type: "private-entry-revoked",
            reason: "control-changed",
          }),
        );
        expect(acquired.lease.current()).toBe(false);
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a legacy no-reply timeout cancels the original request and never accepts its late grant",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers();
        try {
          const host = yield* DesktopBrowserHost.make;
          const backend = yield* connect(host);
          const debuggee = makeDebuggee();
          host.attach(key, debuggee.tab);
          yield* Queue.take(backend.messages);
          const acquiring = yield* Effect.exit(
            Effect.tryPromise(() => host.acquirePrivateEntry(debuggee.tab.webContents)),
          ).pipe(Effect.forkScoped);
          const request = yield* Queue.take(backend.messages);
          if (request.type !== "private-entry-acquire") throw new Error("Expected acquire");
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5000));
          expect(Exit.isFailure(yield* Fiber.join(acquiring))).toBe(true);
          const cancelled = yield* Queue.take(backend.messages);
          expect(cancelled).toMatchObject({
            type: "private-entry-cancel",
            requestId: request.requestId,
          });
          yield* backend.connection.handleCommandLine(
            encodeJson({
              ...request,
              type: "private-entry-granted",
              leaseId: "late",
              generation: 1,
            }),
          );
          expect((yield* Queue.take(backend.messages)).type).toBe("private-entry-cancel");
          expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                Effect.tryPromise(() => host.acquirePrivateEntry(debuggee.tab.webContents)),
              ),
            ),
          ).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "private entry blocks read-only CDP and events and drops pre-entry replies even after resume",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.make;
        const debuggee = makeDebuggee();
        host.attach(key, debuggee.tab);
        const reader = yield* takeEvents(host, 3).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const command = (id: number, method: string) =>
          host.handleCommandLine(
            encodeJson({
              type: "cdp",
              ...key,
              message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
            }),
          );
        yield* command(1, "Page.captureScreenshot");
        host.setPrivateEntry(debuggee.tab.webContents, true);
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
        yield* command(2, "DOM.getDocument");
        debuggee.emit("Runtime.consoleAPICalled", { value: "fake-secret-must-not-relay" });
        yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
        expect(host.isPrivateEntry(debuggee.tab.webContents)).toBe(true);
        host.setPrivateEntry(debuggee.tab.webContents, false);
        yield* command(3, "DOM.enable");
        debuggee.release();
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        const events = yield* Fiber.join(reader);
        expect(
          events.slice(1).map((entry) => decodeCdpReply((entry as { message: string }).message).id),
        ).toEqual([2, 3]);
        expect(JSON.stringify(events)).toContain("private during credential entry");
        expect(JSON.stringify(events)).not.toContain("fake-secret-must-not-relay");
        expect(debuggee.sent).not.toContain("DOM.getDocument");
      }).pipe(Effect.scoped),
  );

  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);
      // A restarted backend subscribes after the attach and still hears it.
      expect(yield* takeEvents(host, 1)).toMatchObject([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toMatchObject([{ type: "attached", ...key }]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
      // Wait until the reader has received the announcement.
      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* command(1, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const [, reply] = yield* Fiber.join(reader);
      // Only the new connection's reply arrives; the old one's id could collide.
      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("saves a server tab's download under its CDP guid where the server asked", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;
      // Before the server sets a directory, Electron keeps its own handling.
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Browser.setDownloadBehavior",
            params: { behavior: "allowAndName", downloadPath: "/srv/downloads" },
          }),
        }),
      );
      debuggee.emit("Browser.downloadWillBegin", { guid: "guid-1", suggestedFilename: "r.csv" });
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(true);
      expect(paths).toEqual(["/srv/downloads/guid-1"]);
    }),
  );

  it.effect("tells a download the person clicked from one the agent's input started", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      // Reading the page is not acting on it.
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({ id: 1, method: "DOM.getDocument", params: {} }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(true);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 2,
            method: "Input.dispatchMouseEvent",
            params: { type: "mousePressed", x: 1, y: 1 },
          }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(false);
    }),
  );
});
