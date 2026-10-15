// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
/**
 * The desktop end of the desktop browser channel (see `DesktopBrowserEvent` in
 * contracts). The primary backend gets two file descriptors at spawn: this
 * service writes events for the desktop's tabs to one and reads commands from
 * the other. Each attached tab is reachable only through its `CdpRelay`.
 *
 * A tab is attached once its `<webview>` registers with a key the web app
 * gave it. The preview manager owns the tab's single debugger session and hands
 * it here; the relay shares it.
 */
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  DesktopBrowserPrivateEntryResponse,
  type DesktopBrowserPrivateEntryAttachment,
  type DesktopBrowserPrivateEntryRequest,
  type DesktopBrowserEvent as DesktopBrowserEventType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodePrivateResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(DesktopBrowserPrivateEntryResponse),
);
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();
/** CDP commands through which an agent clicks, types, or navigates the page. */
const AGENT_INPUT_COMMAND =
  /"method":"(?:Input\.|Page\.navigate"|Runtime\.(?:evaluate|callFunctionOn)")/;
/** How long after an agent's input a download still counts as the agent's. */
const AGENT_DOWNLOAD_WINDOW_MS = 5_000;

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

/** A tab's debugger, as the preview manager lends it to the relay. */
export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
}

const keyOf = ({ threadId, tabId }: DesktopBrowserTabKey) => `${threadId}\u0000${tabId}`;

export interface DesktopBrowserConnection {
  readonly events: Stream.Stream<Uint8Array>;
  readonly handleCommandLine: (line: string) => Effect.Effect<void>;
  readonly closed: Effect.Effect<void>;
}

export interface NativePrivateEntryLease {
  current(): boolean;
  release(): Promise<void>;
}
interface LeaseState {
  readonly requestId: string;
  readonly leaseId: string;
  readonly generation: number;
  active: boolean;
}
interface PendingControl {
  readonly request: DesktopBrowserPrivateEntryRequest;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly accept: (lease?: NativePrivateEntryLease) => void;
  readonly reject: () => void;
}

interface AttachedTab {
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  relay: CdpRelayConnection | null;
  attachment: DesktopBrowserPrivateEntryAttachment | null;
  lease: LeaseState | null;
  pending: PendingControl | null;
  readonly cancelled: Set<string>;
  /** Where the server wants this tab's downloads; null keeps Electron's own handling. */
  downloadDirectory: string | null;
  /** The guid CDP gave the download that is about to start. */
  pendingDownloadGuid: string | null;
  /** When the server last sent this page input, which only an agent does. */
  agentInputAt: number;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    /**
     * Newline-delimited events for a backend's browser fd. Each run starts by
     * announcing the tabs already attached, so a restarted backend hears them.
     */
    readonly events: Stream.Stream<Uint8Array>;
    readonly createConnection: () => DesktopBrowserConnection;
    /** One line from the backend's browser control fd. */
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    /** Offers a server tab's `<webview>` to the server. */
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    /** Withdraws it: closed, swapped, crashed, or devtools needs the debugger. */
    readonly detach: (key: DesktopBrowserTabKey) => void;
    /** Native credential entry blocks every relay operation, including observations. */
    readonly setPrivateEntry: (source: Electron.WebContents, active: boolean) => void;
    readonly isPrivateEntry: (source: Electron.WebContents) => boolean;
    readonly canRequestPrivateEntry: (source: Electron.WebContents) => boolean;
    readonly acquirePrivateEntry: (
      source: Electron.WebContents,
    ) => Promise<NativePrivateEntryLease>;
    /**
     * Whether a server tab's download came from the person at this desktop:
     * the server sent the page no input just before it started.
     */
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
    /** Points a server tab's download at the server; false for any other download. */
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    /** The agent's cursor positions for attached tabs, keyed by their server tab. */
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>;
  }
>()("@t3tools/desktop/preview/DesktopBrowserHost") {}

export const make = Effect.gen(function* () {
  const outbox = yield* PubSub.unbounded<{
    connection: symbol | null;
    event: DesktopBrowserEventType;
  }>();
  const pointers = yield* PubSub.sliding<{
    readonly key: DesktopBrowserTabKey;
    readonly phase: "move" | "click";
    readonly x: number;
    readonly y: number;
  }>(16);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const tabs = new Map<string, AttachedTab>();
  const privateContents = new WeakSet<Electron.WebContents>();
  let activeConnection: symbol | null = null;
  let closeActiveConnection: (() => void) | null = null;
  let channelEpoch: string | null = null;
  const setPrivateEntry = (source: Electron.WebContents, active: boolean) => {
    if (active) privateContents.add(source);
    else privateContents.delete(source);
    for (const tab of tabs.values()) {
      if (tab.debuggee.webContents !== source) continue;
      // Old asynchronous replies must remain invalid even after explicit resume.
      tab.relay = null;
      tab.downloadDirectory = null;
      tab.pendingDownloadGuid = null;
    }
  };
  const emit = (event: DesktopBrowserEventType) =>
    runFork(PubSub.publish(outbox, { connection: activeConnection, event }));

  const unavailable = () => new Error("Native private entry is unavailable");
  const attachedFor = (source: Electron.WebContents) =>
    [...tabs.values()].find((tab) => tab.debuggee.webContents === source);
  const isCurrentAttachment = (tab: AttachedTab) =>
    channelEpoch !== null &&
    activeConnection !== null &&
    tab.attachment?.channelEpoch === channelEpoch &&
    tabs.get(keyOf(tab.key)) === tab &&
    !tab.debuggee.webContents.isDestroyed();
  const cancel = (
    tab: AttachedTab,
    request: Pick<DesktopBrowserPrivateEntryRequest, "channelEpoch" | "attachmentId" | "requestId">,
  ) => {
    tab.cancelled.add(request.requestId);
    if (tab.cancelled.size > 8) tab.cancelled.delete(tab.cancelled.values().next().value!);
    if (isCurrentAttachment(tab))
      emit({
        type: "private-entry-cancel",
        ...tab.key,
        channelEpoch: request.channelEpoch,
        attachmentId: request.attachmentId,
        requestId: request.requestId,
      });
  };
  const invalidate = (tab: AttachedTab) => {
    if (tab.pending) {
      const pending = tab.pending;
      tab.pending = null;
      clearTimeout(pending.timer);
      if (pending.request.type === "private-entry-acquire") cancel(tab, pending.request);
      pending.reject();
    }
    if (tab.lease) {
      tab.lease.active = false;
      setPrivateEntry(tab.debuggee.webContents, true);
      tab.lease = null;
    }
    tab.relay = null;
  };
  const request = (
    tab: AttachedTab,
    message: DesktopBrowserPrivateEntryRequest,
  ): Promise<NativePrivateEntryLease | undefined> =>
    new Promise((resolve, reject) => {
      if (!isCurrentAttachment(tab) || tab.pending) {
        reject(unavailable());
        return;
      }
      const timer = setTimeout(() => {
        if (tab.pending?.request !== message) return;
        tab.pending = null;
        setPrivateEntry(tab.debuggee.webContents, true);
        if (message.type === "private-entry-acquire") cancel(tab, message);
        if (tab.lease) tab.lease.active = false;
        reject(unavailable());
      }, 5000);
      tab.pending = {
        request: message,
        timer,
        accept: resolve,
        reject: () => reject(unavailable()),
      };
      emit(message);
    });
  const leaseHandle = (tab: AttachedTab, lease: LeaseState): NativePrivateEntryLease => ({
    current: () => isCurrentAttachment(tab) && tab.lease === lease && lease.active,
    async release() {
      if (
        !isCurrentAttachment(tab) ||
        tab.lease !== lease ||
        !lease.active ||
        !tab.attachment ||
        tab.pending
      )
        throw unavailable();
      // A release is a distinct request; the ACK must echo this request and the OLD lease generation.
      await request(tab, {
        type: "private-entry-release",
        ...tab.key,
        ...tab.attachment,
        requestId: NodeCrypto.randomUUID(),
        leaseId: lease.leaseId,
        generation: lease.generation,
      });
    },
  });
  const acquirePrivateEntry = async (source: Electron.WebContents) => {
    const tab = attachedFor(source);
    if (
      !tab ||
      !isCurrentAttachment(tab) ||
      !tab.attachment ||
      tab.pending ||
      tab.lease ||
      privateContents.has(source)
    )
      throw unavailable();
    const result = await request(tab, {
      type: "private-entry-acquire",
      ...tab.key,
      ...tab.attachment,
      requestId: NodeCrypto.randomUUID(),
    });
    if (!result?.current()) throw unavailable();
    return result;
  };
  const handlePrivateResponse = (response: typeof DesktopBrowserPrivateEntryResponse.Type) => {
    const tab = tabs.get(keyOf(response));
    if (
      !tab ||
      !isCurrentAttachment(tab) ||
      !tab.attachment ||
      response.channelEpoch !== tab.attachment.channelEpoch ||
      response.attachmentId !== tab.attachment.attachmentId
    )
      return;
    if (response.type === "private-entry-revoked") {
      const lease = tab.lease;
      if (
        !lease ||
        response.requestId !== lease.requestId ||
        response.leaseId !== lease.leaseId ||
        response.generation !== lease.generation
      )
        return;
      invalidate(tab);
      return;
    }
    const pending = tab.pending;
    if (!pending || pending.request.requestId !== response.requestId) {
      if (response.type === "private-entry-granted" && tab.cancelled.has(response.requestId))
        cancel(tab, response);
      return;
    }
    const incomingGrant =
      response.type === "private-entry-granted" && pending.request.type === "private-entry-acquire";
    const incomingRelease =
      response.type === "private-entry-released" &&
      pending.request.type === "private-entry-release" &&
      response.leaseId === pending.request.leaseId &&
      response.generation === pending.request.generation &&
      tab.lease?.active === true &&
      tab.lease.leaseId === response.leaseId &&
      tab.lease.generation === response.generation;
    const incomingRefusal = response.type === "private-entry-refused";
    if (!incomingGrant && !incomingRelease && !incomingRefusal) return;
    clearTimeout(pending.timer);
    tab.pending = null;
    if (incomingGrant) {
      const lease: LeaseState = {
        requestId: response.requestId,
        leaseId: response.leaseId,
        generation: response.generation,
        active: true,
      };
      tab.lease = lease;
      pending.accept(leaseHandle(tab, lease));
    } else if (incomingRelease) {
      if (tab.lease) tab.lease.active = false;
      tab.lease = null;
      pending.accept();
    } else {
      if (pending.request.type === "private-entry-release" && tab.lease) tab.lease.active = false;
      if (pending.request.type === "private-entry-acquire") cancel(tab, pending.request);
      pending.reject();
    }
  };

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee } = tab.debuggee;
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: (method, params, sessionId) => {
          if (privateContents.has(webContents) || tab.relay !== relay)
            return Promise.reject(new Error("Private credential entry"));
          return sessionId === undefined
            ? debuggee.sendCommand(method, params)
            : debuggee.sendCommand(method, params, sessionId);
        },
        targetId: async () => {
          if (privateContents.has(webContents) || tab.relay !== relay)
            throw new Error("Private credential entry");
          const result: { targetInfo: { targetId: string } } =
            await debuggee.sendCommand("Target.getTargetInfo");
          if (privateContents.has(webContents) || tab.relay !== relay)
            throw new Error("Private credential entry");
          return result.targetInfo.targetId;
        },
        url: () => webContents.getURL(),
        title: () => webContents.getTitle(),
        userAgent: () => webContents.getUserAgent(),
        setDownloadDirectory: (directory) => {
          if (!privateContents.has(webContents) && tab.relay === relay)
            tab.downloadDirectory = directory;
        },
      },
      // A released relay's late replies belong to a connection that is gone.
      (message) => {
        if (
          !privateContents.has(webContents) &&
          tab.relay === relay &&
          tabs.get(keyOf(tab.key)) === tab
        ) {
          emit({ type: "cdp", ...tab.key, message });
        }
      },
    );
    tab.relay = relay;
    return relay;
  };

  /**
   * Saves a download from a server tab where the server's Playwright expects
   * it. Without a path Electron would open its Save dialog over the app for a
   * file the agent asked for. CDP names the download just before this runs.
   */
  const placeDownload = (source: Electron.WebContents, item: Electron.DownloadItem) => {
    const tab = [...tabs.values()].find(
      (candidate) =>
        candidate.debuggee.webContents === source &&
        !privateContents.has(source) &&
        candidate.downloadDirectory,
    );
    if (!tab?.downloadDirectory || !tab.pendingDownloadGuid) return false;
    item.setSavePath(NodePath.join(tab.downloadDirectory, tab.pendingDownloadGuid));
    tab.pendingDownloadGuid = null;
    return true;
  };

  const detach = (key: DesktopBrowserTabKey) => {
    const id = keyOf(key);
    const tab = tabs.get(id);
    if (!tab) return;
    invalidate(tab);
    tabs.delete(id);
    tab.debuggee.debugger.off("message", tab.onMessage);
    emit({ type: "detached", ...key, ...(tab.attachment ? { privateEntry: tab.attachment } : {}) });
  };

  const attach = (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const tab: AttachedTab = {
      key,
      debuggee,
      relay: null,
      attachment: channelEpoch ? { channelEpoch, attachmentId: NodeCrypto.randomUUID() } : null,
      pending: null,
      lease: null,
      cancelled: new Set(),
      downloadDirectory: null,
      pendingDownloadGuid: null,
      agentInputAt: Number.NEGATIVE_INFINITY,
      onMessage: (_event, method, params, sessionId) => {
        if (privateContents.has(debuggee.webContents)) return;
        if (method === "Browser.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        tab.relay?.event(method, params, sessionId);
      },
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    emit({ type: "attached", ...key, ...(tab.attachment ? { privateEntry: tab.attachment } : {}) });
  };

  const handleCommandLine = (line: string) =>
    Effect.sync(() => {
      // Reservation metadata must survive the private CDP early return.
      const control = decodePrivateResponse(line);
      if (Option.isSome(control)) {
        handlePrivateResponse(control.value);
        return;
      }
      const command = decodeCommand(line);
      if (Option.isNone(command)) return;
      const tab = tabs.get(keyOf(command.value));
      if (!tab) return;
      if (privateContents.has(tab.debuggee.webContents)) {
        if (command.value.type === "cdp") {
          try {
            const request: unknown = JSON.parse(command.value.message);
            if (
              typeof request === "object" &&
              request !== null &&
              "id" in request &&
              typeof request.id === "number"
            )
              emit({
                type: "cdp",
                ...tab.key,
                message: JSON.stringify({
                  id: request.id,
                  error: { code: -32000, message: "This tab is private during credential entry." },
                }),
              });
          } catch {
            /* Ignore malformed protocol messages without exposing payloads. */
          }
        }
        return;
      }
      if (command.value.type === "pointer") {
        const { threadId, tabId, phase, x, y } = command.value;
        runFork(PubSub.publish(pointers, { key: { threadId, tabId }, phase, x, y }));
        return;
      }
      if (command.value.type === "release") {
        // A new server connection starts with a fresh relay and fresh sessions.
        tab.relay = null;
        return;
      }
      if (command.value.type !== "cdp") return;
      if (AGENT_INPUT_COMMAND.test(command.value.message)) tab.agentInputAt = performance.now();
      relayFor(tab).receive(command.value.message);
    });

  const humanStartedDownload = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentInputAt > AGENT_DOWNLOAD_WINDOW_MS;
  };

  // Read when a backend starts, not when the host is built.
  const announceAll = Effect.suspend(() =>
    Effect.forEach(
      [...tabs.values()],
      (tab) => {
        invalidate(tab);
        tab.attachment = channelEpoch
          ? { channelEpoch, attachmentId: NodeCrypto.randomUUID() }
          : null;
        tab.cancelled.clear();
        return PubSub.publish(outbox, {
          connection: activeConnection,
          event: {
            type: "attached",
            ...tab.key,
            ...(tab.attachment ? { privateEntry: tab.attachment } : {}),
          },
        });
      },
      { discard: true },
    ),
  );

  const createConnection = (): DesktopBrowserConnection => {
    const token = Symbol();
    const epoch = NodeCrypto.randomUUID();
    const stopped = Promise.withResolvers<void>();
    let closed = false;
    let subscribed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      stopped.resolve();
      if (activeConnection !== token) return;
      activeConnection = null;
      channelEpoch = null;
      closeActiveConnection = null;
      for (const tab of tabs.values()) {
        invalidate(tab);
        tab.attachment = null;
      }
    };
    return {
      closed: Effect.sync(close),
      handleCommandLine: (line) =>
        Effect.suspend(() =>
          !closed && activeConnection === token ? handleCommandLine(line) : Effect.void,
        ),
      events: Stream.unwrap(
        Effect.gen(function* () {
          if (closed || subscribed) return Stream.empty;
          subscribed = true;
          closeActiveConnection?.();
          activeConnection = token;
          channelEpoch = epoch;
          closeActiveConnection = close;
          yield* Effect.addFinalizer(() => Effect.sync(close));
          const subscription = yield* PubSub.subscribe(outbox);
          yield* announceAll;
          return Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (item) => !closed && activeConnection === token && item.connection === token,
            ),
            Stream.map((item) => lineEncoder.encode(`${encodeEvent(item.event)}\n`)),
            Stream.interruptWhen(Effect.promise(() => stopped.promise)),
          );
        }),
      ),
    };
  };

  return DesktopBrowserHost.of({
    pointers: Stream.fromPubSub(pointers),
    // Compatibility for fixtures/legacy callers; primary backend must capture createConnection().
    events: Stream.unwrap(Effect.sync(() => createConnection().events)),
    createConnection,
    handleCommandLine,
    attach,
    detach,
    setPrivateEntry,
    isPrivateEntry: (source) => privateContents.has(source),
    canRequestPrivateEntry: (source) => {
      const tab = attachedFor(source);
      return !!tab && isCurrentAttachment(tab);
    },
    acquirePrivateEntry,
    placeDownload,
    humanStartedDownload,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
