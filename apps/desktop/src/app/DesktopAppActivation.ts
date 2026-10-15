// @effect-diagnostics nodeBuiltinImport:off -- Local socket ownership checks need lstat, an atomic rename, and a directory watch at the Node adapter boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationRequest,
  MainRendererLocalDiagnosticsHello,
  MainRendererLocalDiagnosticsCapability,
  MainRendererLocalDiagnosticsRead,
  MainRendererLocalDiagnosticsResult,
  type MainRendererDiagnosticsReadInput,
  type MainRendererDiagnosticsReadResult,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as MainRendererDiagnostics from "../ipc/methods/mainRendererDiagnostics.ts";
import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const isDesktopAppActivationRequest = Schema.is(DesktopAppActivationRequest);

export class DesktopAppActivationStartError extends Schema.TaggedError<DesktopAppActivationStartError>()(
  "DesktopAppActivationStartError",
  {
    address: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not start the desktop app control socket at ${this.address}.`;
  }
}

interface RunningControlServer {
  /** Binds the address again if its socket file is gone. Directory changes run this too. */
  readonly reclaim: () => Promise<void>;
  readonly close: () => Promise<void>;
}

function invalidResponse(requestId: string, message: string): DesktopAppActivationResponse {
  return {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId,
    ok: false,
    code: "invalid-request",
    message,
  };
}

function requestIdFromUnknown(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    value.requestId.trim().length > 0
  ) {
    return value.requestId;
  }
  return "invalid-request";
}

/** Makes sure the socket directory is safe to use. Returns true when it had to create it. */
async function prepareUnixDirectory(input: {
  readonly directory: string;
  readonly userId: number | undefined;
}): Promise<boolean> {
  const created = await NodeFSP.mkdir(input.directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(input.directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${input.directory} is not a directory.`);
  }
  if (input.userId !== undefined && stat.uid !== input.userId) {
    throw new Error(`${input.directory} is owned by another user.`);
  }
  await NodeFSP.chmod(input.directory, 0o700);
  return created !== undefined;
}

async function inodeAt(path: string): Promise<number | null> {
  return NodeFSP.lstat(path).then(
    (stat) => stat.ino,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
}

function closeServer(server: NodeNet.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Serves `t3 app` requests on the local control address until `close`.
 *
 * Two desktop apps can share one state dir, for example nightly and a preview
 * build. They share one socket path, so on Unix:
 * - The newest app takes the path over.
 * - `close` removes the socket file only while it is still this app's socket.
 * - An app binds the path again when it is gone, for example after the app that
 *   took it over quits.
 */
export async function startDesktopAppControlServer(input: {
  readonly address: string;
  readonly directory: string | null;
  readonly userId: number | undefined;
  readonly handle: (request: DesktopAppActivationRequest) => Promise<DesktopAppActivationResponse>;
  readonly cancel: (requestId: string) => void;
  readonly onReclaimError: (error: unknown) => void;
  readonly diagnostics?: {
    readonly mainPid: number;
    readonly stateDir: string;
    readonly appVersion: string;
    readonly read: (
      source: string,
      alive: () => boolean,
      input: MainRendererDiagnosticsReadInput,
    ) => Promise<MainRendererDiagnosticsReadResult>;
    readonly cancel: (source: string) => void;
  };
}): Promise<RunningControlServer> {
  const sockets = new Set<NodeNet.Socket>();
  let diagnosticOwner: NodeNet.Socket | undefined;
  const decodeHello = Schema.decodeUnknownOption(MainRendererLocalDiagnosticsHello, {
    onExcessProperty: "error",
  });
  const decodeRead = Schema.decodeUnknownOption(MainRendererLocalDiagnosticsRead, {
    onExcessProperty: "error",
  });
  const encodeDiagnostic = Schema.encodeSync(
    Schema.fromJsonString(
      Schema.Union([MainRendererLocalDiagnosticsCapability, MainRendererLocalDiagnosticsResult]),
    ),
  );
  const sameTarget = Schema.toEquivalence(MainRendererLocalDiagnosticsHello.fields.target);
  const now = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
  const handleConnection = (socket: NodeNet.Socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    let responseSent = false;
    let activeRequestId: string | null = null;
    let hello: MainRendererLocalDiagnosticsHello | undefined;
    let capabilityNonce: string | undefined;
    let source: string | undefined;
    const connectedAt = now();
    let diagnosticStartedAt = 0;
    let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;

    socket.setTimeout(5_000, () => socket.destroy());

    const finish = (response: DesktopAppActivationResponse) => {
      responseSent = true;
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
    };

    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        handled = true;
        finish(invalidResponse("invalid-request", "The desktop app request is too large."));
        return;
      }

      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish(invalidResponse("invalid-request", "The desktop app request is not valid JSON."));
        return;
      }

      // A new typed passive operation must never enter the activation broker.
      if (
        hello ||
        (typeof parsed === "object" &&
          parsed !== null &&
          "type" in parsed &&
          (parsed.type === "main-renderer-diagnostics-hello" ||
            parsed.type === "main-renderer-diagnostics-read"))
      ) {
        const bridge = input.diagnostics;
        if (!bridge || input.directory === null) {
          socket.destroy();
          return;
        }
        if (!hello) {
          const decoded = decodeHello(parsed);
          if (Option.isNone(decoded) || diagnosticOwner || buffer.length !== 0) {
            socket.destroy();
            return;
          }
          const request = decoded.value;
          const started = now();
          if (
            started < connectedAt ||
            started - connectedAt >= 2_000 ||
            request.expectedMainPid !== bridge.mainPid ||
            request.stateDir !== bridge.stateDir ||
            request.expiresAtMs <= started ||
            request.expiresAtMs - started > 5_000
          ) {
            socket.destroy();
            return;
          }
          diagnosticOwner = socket;
          hello = request;
          diagnosticStartedAt = connectedAt;
          capabilityNonce = NodeCrypto.randomUUID();
          source = `local:${capabilityNonce}`;
          socket.setTimeout(0);
          diagnosticTimer = setTimeout(
            () => socket.destroy(),
            Math.min(2_000 - (started - connectedAt), request.expiresAtMs - started),
          );
          socket.write(
            `${encodeDiagnostic({
              version: 1,
              type: "main-renderer-diagnostics-capability",
              requestId: request.requestId,
              requestNonce: request.requestNonce,
              capabilityNonce,
              mainPid: bridge.mainPid,
              stateDir: bridge.stateDir,
              appVersion: bridge.appVersion,
            })}\n`,
          );
          return;
        }
        const decoded = decodeRead(parsed);
        handled = true;
        const bound = hello;
        const cap = capabilityNonce;
        const ownedSource = source;
        const current = now();
        if (
          Option.isNone(decoded) ||
          !cap ||
          !ownedSource ||
          buffer.length !== 0 ||
          decoded.value.capabilityNonce !== cap ||
          decoded.value.input.requestId !== bound.requestId ||
          decoded.value.input.requestNonce !== bound.requestNonce ||
          decoded.value.input.expiresAtMs !== bound.expiresAtMs ||
          !sameTarget(decoded.value.input.target, bound.target) ||
          current < diagnosticStartedAt ||
          current >= bound.expiresAtMs ||
          current - diagnosticStartedAt >= 2_000
        ) {
          socket.destroy();
          return;
        }
        const alive = () =>
          !socket.destroyed &&
          diagnosticOwner === socket &&
          now() >= diagnosticStartedAt &&
          now() - diagnosticStartedAt < 2_000 &&
          now() < bound.expiresAtMs;
        void bridge.read(ownedSource, alive, decoded.value.input).then(
          (result) => {
            if (!alive()) {
              socket.destroy();
              return;
            }
            responseSent = true;
            socket.end(
              `${encodeDiagnostic({
                version: 1,
                type: "main-renderer-diagnostics-result",
                requestId: bound.requestId,
                requestNonce: bound.requestNonce,
                capabilityNonce: cap,
                result,
              })}\n`,
            );
          },
          () => socket.destroy(),
        );
        return;
      }
      handled = true;
      socket.setTimeout(0);
      if (!isDesktopAppActivationRequest(parsed)) {
        finish(
          invalidResponse(requestIdFromUnknown(parsed), "The desktop app request is invalid."),
        );
        return;
      }
      activeRequestId = parsed.requestId;
      void input.handle(parsed).then(finish, () => {
        finish(
          invalidResponse(parsed.requestId, "T3 Code could not process the desktop app request."),
        );
      });
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      if (diagnosticTimer) clearTimeout(diagnosticTimer);
      if (diagnosticOwner === socket) diagnosticOwner = undefined;
      if (source) input.diagnostics?.cancel(source);
      if (!responseSent && activeRequestId !== null) input.cancel(activeRequestId);
    });
  };

  const listen = (address: string) =>
    new Promise<NodeNet.Server>((resolve, reject) => {
      const server = NodeNet.createServer(handleConnection);
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(server);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(address);
    });

  // Closing a Unix socket server unlinks the path it was bound to, even when
  // another app's socket lives there now. Bind a staging path and move it onto
  // the address instead, so a later close only unlinks the staging path, which
  // is already gone. `rename` takes the address over in one step. `link` claims
  // it only while it is free, and fails with EEXIST otherwise.
  const bindUnix = async (directory: string, mode: "take-over" | "claim-free") => {
    const staging = NodePath.join(directory, `${NodeCrypto.randomBytes(6).toString("hex")}.tmp`);
    const server = await listen(staging);
    try {
      await NodeFSP.chmod(staging, 0o600);
      const inode = await inodeAt(staging);
      if (mode === "take-over") {
        await NodeFSP.rename(staging, input.address);
      } else {
        await NodeFSP.link(staging, input.address);
        await NodeFSP.unlink(staging);
      }
      return { server, inode };
    } catch (error) {
      await closeServer(server);
      throw error;
    }
  };

  let server: NodeNet.Server;
  let inode: number | null = null;
  if (input.directory === null) {
    // Named pipes close with the app that owns them, so no other app can remove this one.
    server = await listen(input.address);
  } else {
    await prepareUnixDirectory({ directory: input.directory, userId: input.userId });
    ({ server, inode } = await bindUnix(input.directory, "take-over"));
  }

  let closed = false;
  const reclaimOnce = async () => {
    // Never replace a socket that exists, so two apps cannot trade the path back and forth.
    if (closed || input.directory === null || (await inodeAt(input.address)) !== null) return;
    if (await prepareUnixDirectory({ directory: input.directory, userId: input.userId })) {
      // A watch follows the directory's inode, so a recreated directory needs a new one.
      watchDirectory(input.directory);
    }
    const next = await bindUnix(input.directory, "claim-free").catch(
      (error: NodeJS.ErrnoException) => {
        // Another app bound the address first.
        if (error.code === "EEXIST") return null;
        throw error;
      },
    );
    if (next === null) return;
    const previous = server;
    ({ server, inode } = next);
    previous.close();
  };
  let pendingReclaim = Promise.resolve();
  const reclaim = () => {
    const run = pendingReclaim.then(reclaimOnce);
    pendingReclaim = run.catch(() => undefined);
    return run;
  };
  let watcher: NodeFS.FSWatcher | null = null;
  const watchDirectory = (directory: string) => {
    watcher?.close();
    watcher = null;
    try {
      watcher = NodeFS.watch(directory, { persistent: false }, () => {
        reclaim().catch(input.onReclaimError);
      });
      watcher.on("error", input.onReclaimError);
    } catch (error) {
      // The socket still works without a watcher. It only cannot recover after removal.
      input.onReclaimError(error);
    }
  };
  if (input.directory !== null) {
    watchDirectory(input.directory);
    // Catch a removal that happened before the watcher started.
    reclaim().catch(input.onReclaimError);
  }

  return {
    reclaim,
    close: async () => {
      if (closed) return;
      closed = true;
      // A running reclaim can replace the watcher, so close the watcher after it.
      await pendingReclaim;
      watcher?.close();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      server.removeAllListeners();
      if (inode !== null && (await inodeAt(input.address)) === inode) {
        await NodeFSP.unlink(input.address).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}

export class DesktopAppActivation extends Context.Service<
  DesktopAppActivation,
  {
    readonly start: Effect.Effect<void, DesktopAppActivationStartError, Scope.Scope>;
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
    readonly complete: (response: DesktopAppActivationResponse) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopAppActivation") {}

const { logWarning } = makeComponentLogger("desktop-app-activation");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const desktopEnvironment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const path = yield* Path.Path;
  const userId = yield* HostProcess.UserId;
  const diagnostics = yield* Effect.serviceOption(MainRendererDiagnostics.MainRendererDiagnostics);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const address = resolveDesktopAppControlAddress({
    stateDir: path.resolve(desktopEnvironment.stateDir),
    platform: desktopEnvironment.platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: path.join,
  });
  let registeredWebContents: Electron.WebContents | null = null;
  let detachRendererListeners: (() => void) | null = null;

  const broker = new DesktopAppActivationBroker({
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    activate: () => {
      void runPromise(
        desktopWindow.activate.pipe(
          Effect.catchCause((cause) => logWarning("failed to focus the desktop window", { cause })),
        ),
      );
    },
  });

  const clearRegisteredRenderer = () => {
    detachRendererListeners?.();
    detachRendererListeners = null;
    registeredWebContents = null;
    broker.clearRenderer();
  };

  return DesktopAppActivation.of({
    start: Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          startDesktopAppControlServer({
            ...address,
            userId,
            ...(desktopEnvironment.platform === "linux" &&
            Option.getOrUndefined(desktopEnvironment.profileId) === "weasel" &&
            desktopEnvironment.isPackaged &&
            Option.isSome(diagnostics)
              ? {
                  diagnostics: {
                    mainPid: process.pid,
                    stateDir: path.resolve(desktopEnvironment.stateDir),
                    appVersion: desktopEnvironment.appVersion,
                    read: (
                      source: string,
                      alive: () => boolean,
                      request: MainRendererDiagnosticsReadInput,
                    ) => runPromise(diagnostics.value.read(source, alive, request)),
                    cancel: (source: string) => {
                      void runPromise(diagnostics.value.cancelSource(source));
                    },
                  },
                }
              : {}),
            handle: (request) => broker.request(request),
            cancel: (requestId) => broker.cancel(requestId),
            onReclaimError: (cause) =>
              void runPromise(
                logWarning("failed to restore the desktop app control socket", { cause }),
              ),
          }),
        catch: (cause) => new DesktopAppActivationStartError({ address: address.address, cause }),
      }),
      (server) =>
        Effect.promise(() => server.close()).pipe(
          Effect.catchCause((cause) =>
            logWarning("failed to close the desktop app control socket", { cause }),
          ),
          Effect.ensuring(Effect.sync(() => broker.close())),
        ),
    ).pipe(Effect.asVoid),
    setRendererReady: Effect.fn("DesktopAppActivation.setRendererReady")(function* (ready) {
      if (!ready) {
        clearRegisteredRenderer();
        return;
      }
      const main = yield* electronWindow.main;
      if (Option.isNone(main)) return;
      const webContents = main.value.webContents;
      if (webContents.isDestroyed()) return;

      if (registeredWebContents !== webContents) {
        clearRegisteredRenderer();
        registeredWebContents = webContents;
        const onUnavailable = () => clearRegisteredRenderer();
        const onNavigation = (
          event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (event.isMainFrame && !event.isSameDocument) clearRegisteredRenderer();
        };
        webContents.on("did-start-navigation", onNavigation);
        webContents.once("destroyed", onUnavailable);
        detachRendererListeners = () => {
          webContents.removeListener("did-start-navigation", onNavigation);
          webContents.removeListener("destroyed", onUnavailable);
        };
      }

      broker.registerRenderer((request) => {
        webContents.send(DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, request);
      });
    }),
    complete: (response) => Effect.sync(() => broker.complete(response)),
  });
});

export const layer = Layer.effect(DesktopAppActivation, make);
