// @effect-diagnostics nodeBuiltinImport:off -- Named local socket adapter; private filesystem ownership is checked before and after every exchange.
import * as NodeFS from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  MainRendererLocalDiagnosticsHello,
  MainRendererLocalDiagnosticsCapability,
  MainRendererLocalDiagnosticsRead,
  MainRendererLocalDiagnosticsResult,
  MainRendererDiagnosticsReadInput,
  type MainRendererDiagnosticsReadResult,
  type MainRendererDiagnosticsUnsupportedSite,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";

const unavailable = (
  reason: Extract<MainRendererDiagnosticsReadResult, { status: "unavailable" }>["reason"],
  site?: MainRendererDiagnosticsUnsupportedSite,
): MainRendererDiagnosticsReadResult =>
  reason === "unsupported"
    ? {
        status: "unavailable",
        reason,
        ...(site === undefined ? {} : { unsupportedDiagnostic: { site } }),
      }
    : { status: "unavailable", reason };
const decodeCapability = Schema.decodeUnknownOption(
  Schema.fromJsonString(MainRendererLocalDiagnosticsCapability),
  { onExcessProperty: "error" },
);
const decodeResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(MainRendererLocalDiagnosticsResult),
  { onExcessProperty: "error" },
);
const encodeHello = Schema.encodeEffect(Schema.fromJsonString(MainRendererLocalDiagnosticsHello));
const encodeRead = Schema.encodeSync(Schema.fromJsonString(MainRendererLocalDiagnosticsRead));
const now = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

export interface LocalMainBinding {
  readonly mainPid: number;
  readonly version: string;
  readonly socketInode: number;
  readonly listenerInode: string;
}

/** Current-user filesystem/process binding, not SO_PEERCRED or an adversarial same-UID boundary. */
export async function inspectLocalMainBinding(input: {
  readonly address: string;
  readonly directory: string;
  readonly profileLockPath: string;
  readonly userId: number;
}): Promise<LocalMainBinding> {
  const directory = await NodeFS.lstat(input.directory);
  const socket = await NodeFS.lstat(input.address);
  const lock = await NodeFS.lstat(input.profileLockPath);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== input.userId ||
    (directory.mode & 0o777) !== 0o700 ||
    !socket.isSocket() ||
    socket.uid !== input.userId ||
    (socket.mode & 0o777) !== 0o600 ||
    !lock.isSymbolicLink() ||
    lock.uid !== input.userId
  )
    throw new Error("local-main-ownership-unavailable");
  const target = await NodeFS.readlink(input.profileLockPath);
  const prefix = `${NodeOS.hostname()}-`;
  if (!target.startsWith(prefix) || !/^[1-9][0-9]*$/.test(target.slice(prefix.length)))
    throw new Error("local-main-profile-unavailable");
  const pid = Number(target.slice(prefix.length));
  const executable = await NodeFS.readlink(`/proc/${pid}/exe`);
  const version =
    /^\/nix\/store\/[a-z0-9]{32}-t3code-weasel-([^/]+)\/lib\/t3code-weasel\/t3code$/.exec(
      executable,
    )?.[1];
  if (!version) throw new Error("local-main-executable-unavailable");
  const unix = await NodeFS.readFile("/proc/net/unix", "utf8");
  const entries = await NodeFS.readdir(`/proc/${pid}/fd`);
  const links = await Promise.all(
    entries.map((entry) => NodeFS.readlink(`/proc/${pid}/fd/${entry}`).catch(() => "")),
  );
  // The canonical server binds a random staging pathname then renames it onto
  // the control address. Linux retains that original name in /proc/net/unix.
  // Require one Main-owned listener in this exact private directory; ambiguity
  // refuses. This is the accepted current-user binding, not peer authentication.
  const rows = unix
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => {
      const path = row[7];
      return (
        path !== undefined &&
        row[6] !== undefined &&
        (path === input.address ||
          (NodePath.dirname(path) === input.directory &&
            /^[a-f0-9]{12}\.tmp$/.test(NodePath.basename(path)))) &&
        row[3] === "00010000" &&
        links.includes(`socket:[${row[6]}]`)
      );
    });
  if (rows.length !== 1 || !rows[0]?.[6]) throw new Error("local-main-listener-unavailable");
  const listenerInode = rows[0][6];
  return { mainPid: pid, version, socketInode: socket.ino, listenerInode };
}

const sameBinding = (a: LocalMainBinding, b: LocalMainBinding) =>
  a.mainPid === b.mainPid &&
  a.version === b.version &&
  a.socketInode === b.socketInode &&
  a.listenerInode === b.listenerInode;

function exchange(input: {
  readonly address: string;
  readonly stateDir: string;
  readonly request: MainRendererDiagnosticsReadInput;
  readonly hello: string;
  readonly binding: LocalMainBinding;
  readonly inspect: () => Promise<LocalMainBinding>;
  readonly signal: AbortSignal;
}): Promise<MainRendererDiagnosticsReadResult> {
  return new Promise((resolve) => {
    const started = now();
    const socket = NodeNet.createConnection(input.address);
    let buffer = "";
    let totalBytes = 0;
    let settled = false;
    let receiving = false;
    let capability: MainRendererLocalDiagnosticsCapability | undefined;
    const finish = (result: MainRendererDiagnosticsReadResult) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      socket.destroy();
      resolve(result);
    };
    const abort = () => finish(unavailable("timeout"));
    const fresh = () =>
      !settled &&
      !input.signal.aborted &&
      now() >= started &&
      now() - started < 2_000 &&
      now() < input.request.expiresAtMs;
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) {
      abort();
      return;
    }
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      if (!fresh()) {
        finish(unavailable("expired"));
        return;
      }
      socket.write(`${input.hello}\n`);
    });
    socket.on("data", (chunk: string) => {
      if (!fresh() || receiving) {
        finish(unavailable("invalid-response"));
        return;
      }
      buffer += chunk;
      totalBytes += Buffer.byteLength(chunk, "utf8");
      if (totalBytes > 32 * 1024) {
        finish(unavailable("invalid-response"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (buffer.length !== 0) {
        finish(unavailable("invalid-response"));
        return;
      }
      receiving = true;
      void input.inspect().then(
        (binding) => {
          if (!fresh() || !sameBinding(binding, input.binding)) {
            finish(unavailable("context-changed"));
            return;
          }
          if (!capability) {
            const parsed = decodeCapability(line);
            if (Option.isNone(parsed)) {
              finish(unavailable("unsupported", "local-capability"));
              return;
            }
            const cap = parsed.value;
            if (
              cap.mainPid !== binding.mainPid ||
              cap.appVersion !== binding.version ||
              cap.stateDir !== input.stateDir ||
              cap.requestId !== input.request.requestId ||
              cap.requestNonce !== input.request.requestNonce
            ) {
              finish(unavailable("not-main"));
              return;
            }
            capability = cap;
            receiving = false;
            socket.write(
              `${encodeRead({ version: 1, type: "main-renderer-diagnostics-read", capabilityNonce: cap.capabilityNonce, input: input.request })}\n`,
            );
            return;
          }
          const parsed = decodeResult(line);
          if (
            Option.isNone(parsed) ||
            parsed.value.requestId !== input.request.requestId ||
            parsed.value.requestNonce !== input.request.requestNonce ||
            parsed.value.capabilityNonce !== capability.capabilityNonce
          ) {
            finish(unavailable("invalid-response"));
            return;
          }
          const result = parsed.value.result;
          if (
            result.status === "ready" &&
            (result.appVersion !== binding.version ||
              result.response.result.status !== "ready" ||
              result.response.binding.expiresAtMs !== result.expiresAtMs ||
              result.observedAtMs < started ||
              result.observedAtMs > now() ||
              result.expiresAtMs - result.observedAtMs > 2_000 ||
              result.response.binding.requestId !== input.request.requestId ||
              result.response.binding.target.environmentId !== input.request.target.environmentId ||
              result.response.binding.target.threadId !== input.request.target.threadId ||
              result.response.binding.target.providerInstanceId !==
                input.request.target.providerInstanceId ||
              result.expiresAtMs > input.request.expiresAtMs ||
              result.expiresAtMs <= now())
          ) {
            finish(unavailable("invalid-response"));
            return;
          }
          finish(result);
        },
        () => finish(unavailable("not-main")),
      );
    });
    socket.once("error", () => finish(unavailable("unsupported", "local-socket-error")));
    socket.once("end", () => {
      if (!receiving) finish(unavailable("source-closed"));
    });
    socket.once("close", () => {
      if (!receiving) finish(unavailable("source-closed"));
    });
  });
}

export class MainRendererDiagnosticsLocalClient extends Context.Service<
  MainRendererDiagnosticsLocalClient,
  {
    readonly read: (
      input: MainRendererDiagnosticsReadInput,
      environmentId: string,
    ) => Effect.Effect<MainRendererDiagnosticsReadResult>;
  }
>()("t3/diagnostics/MainRendererDiagnosticsLocalClient") {}

/** @public Test construction replaces only native process ownership inspection, never framing or Main logic. */
export const make = Effect.fn("MainRendererDiagnosticsLocalClient.make")(function* (options?: {
  readonly inspect?: (address: string, directory: string) => Promise<LocalMainBinding>;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  const home = yield* HostProcess.HomeDirectory;
  let pending = false;
  return MainRendererDiagnosticsLocalClient.of({
    read: (request, environmentId) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeEffect(MainRendererDiagnosticsReadInput, {
          onExcessProperty: "error",
        })(request).pipe(Effect.option);
        if (Option.isNone(decoded)) return unavailable("invalid-response");
        if (request.target.environmentId !== environmentId) return unavailable("target-mismatch");
        if (platform !== "linux") return unavailable("unsupported", "local-platform");
        if (userId === undefined) return unavailable("unsupported", "local-user-id");
        if (
          config.desktopTelemetryFd !== undefined ||
          config.desktopTelemetryControlFd !== undefined
        )
          return unavailable("unsupported", "local-fd-conflict");
        const started = DateTime.toEpochMillis(yield* DateTime.now);
        if (request.expiresAtMs <= started || request.expiresAtMs - started > 5_000)
          return unavailable("expired");
        if (pending) return unavailable("busy");
        pending = true;
        return yield* Effect.gen(function* () {
          const stateDir = NodePath.resolve(config.stateDir);
          const address = resolveDesktopAppControlAddress({
            stateDir,
            platform,
            tempDir: NodeOS.tmpdir(),
            userId,
            joinPath: NodePath.join,
          });
          if (address.directory === null) return unavailable("unsupported", "local-address");
          const directory = address.directory;
          const inspect = () =>
            options?.inspect?.(address.address, directory) ??
            inspectLocalMainBinding({
              address: address.address,
              directory,
              profileLockPath: NodePath.join(home, ".config", "t3code-weasel", "SingletonLock"),
              userId,
            });
          const binding = yield* Effect.tryPromise({
            try: inspect,
            catch: () => "not-main" as const,
          });
          const hello = yield* encodeHello({
            version: 1,
            type: "main-renderer-diagnostics-hello",
            requestId: request.requestId,
            requestNonce: request.requestNonce,
            target: request.target,
            expectedMainPid: binding.mainPid,
            stateDir,
            expiresAtMs: request.expiresAtMs,
          });
          return yield* Effect.tryPromise({
            try: (signal) =>
              exchange({
                address: address.address,
                stateDir,
                request,
                hello,
                binding,
                inspect,
                signal,
              }),
            catch: () => "local-exchange-rejected" as const,
          });
        }).pipe(
          Effect.catch((reason) =>
            Effect.succeed(
              reason === "local-exchange-rejected"
                ? unavailable("unsupported", reason)
                : unavailable(typeof reason === "string" ? reason : "invalid-response"),
            ),
          ),
          Effect.timeoutOption("2 seconds"),
          Effect.map((result) => Option.getOrElse(result, () => unavailable("timeout"))),
          Effect.ensuring(
            Effect.sync(() => {
              pending = false;
            }),
          ),
        );
      }),
  });
});
export const layer = Layer.effect(MainRendererDiagnosticsLocalClient, make());
