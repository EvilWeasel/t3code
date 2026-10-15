// @effect-diagnostics nodeBuiltinImport:off -- This adapter test binds a real local socket or Windows named pipe and verifies its cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProjectId,
  ThreadId,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";

import { startDesktopAppControlServer } from "./DesktopAppActivation.ts";

const openServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function makeTarget(stateDir: string, platform: NodeJS.Platform, userId: number | undefined) {
  return resolveDesktopAppControlAddress({
    stateDir,
    platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: NodePath.join,
  });
}

function request(requestId: string, platform: NodeJS.Platform): DesktopAppActivationRequest {
  return {
    version: 1,
    requestId,
    type: "open-workspace",
    workspaceRoot: NodePath.join(NodeOS.tmpdir(), "project"),
    platform: platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux",
  };
}

function startOkServer(target: ReturnType<typeof makeTarget>, userId: number | undefined) {
  return startDesktopAppControlServer({
    ...target,
    userId,
    handle: async (input) => ({
      version: 1,
      requestId: input.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    }),
    cancel: () => undefined,
    onReclaimError: () => undefined,
  }).then((server) => {
    openServers.push(server);
    return server;
  });
}

function exchange(address: string, payload: DesktopAppActivationRequest) {
  return new Promise<DesktopAppActivationResponse>((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationResponse);
    });
  });
}

describe("desktop app control server", () => {
  it.effect("roundtrips a request and removes its socket on shutdown", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-control-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const received: DesktopAppActivationRequest[] = [];
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: async (input) => {
            received.push(input);
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
            };
          },
          cancel: () => undefined,
          onReclaimError: () => undefined,
        });
        openServers.push(server);

        const response = await exchange(target.address, request("request-1", platform));

        expect(received).toHaveLength(1);
        expect(response).toMatchObject({ ok: true, requestId: "request-1" });
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        if (target.directory !== null) {
          await expect(NodeFSP.stat(target.address)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("cancels a queued request when the client disconnects", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-cancel-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        let resolveCanceled: (requestId: string) => void = () => undefined;
        const canceled = new Promise<string>((resolve) => {
          resolveCanceled = resolve;
        });
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: () => new Promise(() => undefined),
          cancel: resolveCanceled,
          onReclaimError: () => undefined,
        });
        openServers.push(server);
        const socket = NodeNet.createConnection(target.address);
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.write(`${JSON.stringify(request("request-canceled", platform))}\n`, () => {
              socket.destroy();
              resolve();
            });
          });
        });

        await expect(canceled).resolves.toBe("request-canceled");
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  // Two desktop apps can share one state dir, such as nightly and a preview build.
  it.effect("keeps a newer app's socket when an older app on the same state dir quits", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-takeover-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const older = await startOkServer(target, userId);
        await startOkServer(target, userId);

        await older.close();

        await expect(
          exchange(target.address, request("after-quit", platform)),
        ).resolves.toMatchObject({ ok: true, requestId: "after-quit" });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("binds its address again after the socket file is removed", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const userId = yield* HostProcess.UserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-reclaim-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const server = await startOkServer(target, userId);

        await NodeFSP.unlink(target.address);
        await server.reclaim();

        await expect(
          exchange(target.address, request("reclaimed", platform)),
        ).resolves.toMatchObject({
          ok: true,
          requestId: "reclaimed",
        });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );
});

// The new branch is strictly passive; all legacy activation tests above are unchanged.
describe("finite passive local Main control", () => {
  it.each([
    "top-extra",
    "nested-extra",
    "wrong-pid",
    "wrong-nonce",
    "changed-target",
    "valid",
  ] as const)(
    "negotiates only the admitted connection and keeps %s out of activation",
    async (variant) => {
      const Schema = await import("effect/Schema");
      const { MainRendererLocalDiagnosticsCapability, MainRendererLocalDiagnosticsResult } =
        await import("@t3tools/contracts");
      const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
      const decodeCapability = Schema.decodeUnknownSync(
        Schema.fromJsonString(MainRendererLocalDiagnosticsCapability),
        { onExcessProperty: "error" },
      );
      const decodeResult = Schema.decodeUnknownSync(
        Schema.fromJsonString(MainRendererLocalDiagnosticsResult),
        { onExcessProperty: "error" },
      );
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "main-passive-"));
      const target = makeTarget(NodePath.join(root, "userdata"), "linux", process.getuid?.());
      let activation = 0;
      let reads = 0;
      const readTarget = {
        environmentId: "24efa85c-862c-4de4-9b5e-aaaa041e28a4",
        threadId: "7cd05d6b-5e09-4691-a664-0b56c6283f12",
        providerInstanceId: "codex",
      };
      const expiresAtMs =
        (await import("effect/DateTime")).toEpochMillis(
          (await import("effect/DateTime")).nowUnsafe(),
        ) + 5_000;
      const server = await startDesktopAppControlServer({
        ...target,
        userId: process.getuid?.(),
        handle: async (r) => {
          activation++;
          return {
            version: 1,
            requestId: r.requestId,
            ok: false,
            code: "internal-error",
            message: "not activation",
          };
        },
        cancel: () => {
          activation++;
        },
        onReclaimError: () => undefined,
        diagnostics: {
          mainPid: process.pid,
          stateDir: NodePath.join(root, "userdata"),
          appVersion: "fixture",
          read: async () => {
            reads++;
            return { status: "unavailable", reason: "context-changed" };
          },
          cancel: () => undefined,
        },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = NodeNet.createConnection(target.address);
          socket.setEncoding("utf8");
          let buffer = "";
          let capSeen = false;
          socket.once("error", reject);
          socket.once("close", () => resolve());
          socket.once("connect", () =>
            socket.write(
              `${encode({
                version: 1,
                type: "main-renderer-diagnostics-hello",
                requestId: "read",
                requestNonce: "nonce",
                expectedMainPid: variant === "wrong-pid" ? process.pid + 1 : process.pid,
                stateDir: NodePath.join(root, "userdata"),
                expiresAtMs,
                target:
                  variant === "nested-extra"
                    ? { ...readTarget, rawSettings: "refused" }
                    : readTarget,
                ...(variant === "top-extra" ? { rawSettings: "refused" } : {}),
              })}\n`,
            ),
          );
          socket.on("data", (chunk: string) => {
            try {
              buffer += chunk;
              const end = buffer.indexOf("\n");
              if (end < 0) return;
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              if (!capSeen) {
                const cap = decodeCapability(line);
                capSeen = true;
                socket.write(
                  `${encode({
                    version: 1,
                    type: "main-renderer-diagnostics-read",
                    capabilityNonce: variant === "wrong-nonce" ? "other" : cap.capabilityNonce,
                    input: {
                      requestId: "read",
                      requestNonce: "nonce",
                      optIn: true,
                      expiresAtMs,
                      target:
                        variant === "changed-target"
                          ? { ...readTarget, providerInstanceId: "other" }
                          : readTarget,
                    },
                  })}\n`,
                );
              } else {
                const result = decodeResult(line);
                expect(result.result.status).toBe("unavailable");
                socket.destroy();
              }
            } catch (error) {
              socket.destroy();
              reject(error);
            }
          });
        });
        expect(reads).toBe(variant === "valid" ? 1 : 0);
        expect(activation).toBe(0);
      } finally {
        await server.close();
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
