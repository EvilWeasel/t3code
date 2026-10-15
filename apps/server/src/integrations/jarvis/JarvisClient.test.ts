import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { describe, expect, it } from "@effect/vitest";
import { JarvisNativeRequest } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Socket from "effect/socket/Socket";

import * as JarvisClient from "./JarvisClient.ts";

const request: JarvisNativeRequest = {
  jsonrpc: "2.0",
  id: "fixture-rpc",
  method: "jarvis.catalog",
  params: {
    binding: {
      engineSessionId: "engine-1",
      origin: {
        environmentId: "env-1",
        projectId: "project-1",
        parentThreadId: "parent-1",
        parentRunId: "parent-run-1",
        parentRootNodeId: "parent-root-1",
        taskId: "task-1",
        childThreadId: "child-1",
        childRunId: "child-run-1",
        childRootNodeId: "actual-child-root-1",
      },
    },
  },
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const makePeer = (
  respond: (
    request: JarvisNativeRequest,
    writer: Socket.Writer,
  ) => Effect.Effect<void, Socket.SocketError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtime = yield* fs.makeTempDirectoryScoped({ prefix: "jarvis-ipc-" });
    yield* fs.chmod(runtime, 0o700);
    const directory = path.join(runtime, "jarvis-native");
    yield* fs.makeDirectory(directory);
    yield* fs.chmod(directory, 0o700);
    const socketPath = path.join(directory, "jarvis-v1.sock");
    const server = yield* NodeSocketServer.make({ path: socketPath });
    yield* fs.chmod(socketPath, 0o600);
    const calls = yield* Ref.make(0);
    const received = yield* Ref.make<ReadonlyArray<JarvisNativeRequest>>([]);
    yield* server
      .run((socket) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (count) => count + 1);
          const reader = yield* socket.reader;
          const writer = yield* socket.writer;
          let text = "";
          while (!text.includes("\n")) {
            const chunks = yield* reader.pull;
            for (const chunk of chunks)
              text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
          }
          const actual = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(JarvisNativeRequest),
          )(text.trim());
          yield* Ref.update(received, (requests) => [...requests, actual]);
          yield* respond(actual, writer);
        }).pipe(Effect.scoped, Effect.orDie),
      )
      .pipe(Effect.forkScoped);
    const layer = JarvisClient.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            XDG_RUNTIME_DIR: runtime,
            MORROWBYTE_JARVIS_ENGINE_SESSION_ID: "engine-1",
          }),
        ),
      ),
    );
    return { layer, calls, received, directory, socketPath };
  });

describe("Jarvis native Unix client", () => {
  it.live(
    "uses the private configured socket and preserves the canonical task/root correlation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const peer = yield* makePeer((actual, writer) =>
            writer.write(
              encodeJson({
                jsonrpc: "2.0",
                id: actual.id,
                result: { schema: "jarvis.v1", engineSessionId: "engine-1" },
              }) + "\n",
            ),
          );
          const result = yield* Effect.gen(function* () {
            return yield* (yield* JarvisClient.JarvisClient).call(request);
          }).pipe(Effect.provide(peer.layer));
          expect(result).toMatchObject({ id: request.id, result: { engineSessionId: "engine-1" } });
          expect(yield* Ref.get(peer.received)).toEqual([request]);
          expect(yield* Ref.get(peer.calls)).toBe(1);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
  );

  it.live("rejects engine mismatch and public socket permissions before opening a connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* makePeer(() => Effect.void);
        yield* Effect.gen(function* () {
          const client = yield* JarvisClient.JarvisClient;
          const wrongEngine = {
            ...request,
            params: {
              ...request.params,
              binding: { ...request.params.binding, engineSessionId: "other-engine" },
            },
          };
          expect((yield* client.call(wrongEngine).pipe(Effect.flip)).code).toBe("invalid_binding");
          const fs = yield* FileSystem.FileSystem;
          yield* fs.chmod(peer.socketPath, 0o666);
          expect((yield* client.call(request).pipe(Effect.flip)).code).toBe("unavailable");
          expect(yield* Ref.get(peer.calls)).toBe(0);
        }).pipe(Effect.provide(peer.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("reports a lost response as unknown and performs zero automatic retries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* makePeer(() => Effect.void);
        const failure = yield* Effect.gen(function* () {
          return yield* (yield* JarvisClient.JarvisClient).call(request).pipe(Effect.flip);
        }).pipe(Effect.provide(peer.layer));
        expect(failure.code).toBe("outcome_unknown");
        expect(yield* Ref.get(peer.calls)).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("keeps an atomic subscription ACK before a fragmented UTF-8 notification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* makePeer((actual, writer) => {
          const ack =
            encodeJson({
              jsonrpc: "2.0",
              id: actual.id,
              result: { schema: "jarvis.v1", engineSessionId: "engine-1", cursor: "4", jobs: [] },
            }) + "\n";
          const event = new TextEncoder().encode(
            encodeJson({
              jsonrpc: "2.0",
              method: "jarvis.event",
              params: {
                engineSessionId: "engine-1",
                event: {
                  schema: "jarvis.v1",
                  sequence: "7",
                  emittedAt: "2026-10-15T00:00:00Z",
                  jobId: "job-1",
                  payload: {
                    kind: "message_delta",
                    messageId: "message-1",
                    revision: 1,
                    text: "🦦",
                    final: false,
                  },
                },
              },
            }) + "\n",
          );
          const split = event.indexOf(0xf0) + 1;
          return writer.writeAll([ack, event.subarray(0, split), event.subarray(split)]);
        });
        const subscribe = { ...request, method: "jarvis.subscribe" as const };
        const messages = yield* Effect.gen(function* () {
          const client = yield* JarvisClient.JarvisClient;
          return yield* client.subscribe(subscribe).pipe(Stream.take(2), Stream.runCollect);
        }).pipe(Effect.provide(peer.layer));
        expect(messages).toMatchObject([
          { result: { cursor: "4" } },
          { method: "jarvis.event", params: { event: { sequence: "7", payload: { text: "🦦" } } } },
        ]);
        expect(yield* Ref.get(peer.calls)).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
