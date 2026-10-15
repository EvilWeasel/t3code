import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  JarvisNativeNotification,
  JarvisNativeRequest,
  JarvisNativeResponse,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Socket from "effect/socket/Socket";

export class JarvisTransportError extends Schema.TaggedError<JarvisTransportError>()(
  "JarvisTransportError",
  {
    code: Schema.Literals(["unavailable", "invalid_binding", "invalid_frame", "outcome_unknown"]),
    message: Schema.String,
  },
) {}

export class JarvisClient extends Context.Service<
  JarvisClient,
  {
    readonly engineSessionId: string | null;
    readonly call: (
      request: JarvisNativeRequest,
    ) => Effect.Effect<JarvisNativeResponse, JarvisTransportError>;
    readonly subscribe: (
      request: Extract<JarvisNativeRequest, { readonly method: "jarvis.subscribe" }>,
    ) => Stream.Stream<JarvisNativeResponse | JarvisNativeNotification, JarvisTransportError>;
  }
>()("t3/integrations/jarvis/JarvisClient") {}

const MAX_FRAME = 1_048_576;
const transportError = (code: JarvisTransportError["code"], message: string) =>
  new JarvisTransportError({ code, message });
const unknownOutcome = () =>
  transportError(
    "outcome_unknown",
    "The native operation outcome is unknown. Reconcile the existing request/job; do not resubmit automatically.",
  );
const jsonCodec = Schema.fromJsonString(Schema.Json);

// A bounded NDJSON reader retains fragments across pulls and queued frames.
// UTF-8 is decoded only after assembling a complete bounded byte frame.
const frameReader = (reader: Socket.Reader) => {
  let chunks: ReadonlyArray<Uint8Array | string> = [];
  let chunkIndex = 0;
  let current: Uint8Array = new Uint8Array();
  let offset = 0;
  const frame = new Uint8Array(MAX_FRAME);
  let size = 0;
  return Effect.gen(function* () {
    while (true) {
      if (offset === current.length) {
        if (chunkIndex === chunks.length) {
          chunks = yield* reader.pull.pipe(Effect.mapError(unknownOutcome));
          chunkIndex = 0;
          if (chunks.length > 256)
            return yield* transportError(
              "invalid_frame",
              "Native response batch exceeds its bound.",
            );
        }
        const next = chunks[chunkIndex++]!;
        current = typeof next === "string" ? new TextEncoder().encode(next) : next;
        offset = 0;
      }
      const newline = current.indexOf(10, offset);
      const end = newline < 0 ? current.length : newline;
      const part = current.subarray(offset, end);
      if (size + part.length > MAX_FRAME)
        return yield* transportError(
          "invalid_frame",
          "Native response frame exceeds its bound; reconnect with a snapshot.",
        );
      frame.set(part, size);
      size += part.length;
      offset = newline < 0 ? end : end + 1;
      if (newline < 0) continue;
      const complete = frame.subarray(0, size);
      size = 0;
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(complete),
        catch: () => transportError("invalid_frame", "Native response is not valid UTF-8."),
      });
      return yield* Schema.decodeUnknownEffect(jsonCodec)(text).pipe(
        Effect.mapError(() =>
          transportError("invalid_frame", "Native response is not valid JSON."),
        ),
      );
    }
  });
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtime = yield* Config.String("XDG_RUNTIME_DIR").pipe(Config.option);
  const configuredEngine = yield* Config.String("MORROWBYTE_JARVIS_ENGINE_SESSION_ID").pipe(
    Config.option,
  );
  const engineSessionId = Option.getOrNull(configuredEngine);
  const connect = (request: JarvisNativeRequest) =>
    Effect.gen(function* () {
      if (
        process.platform !== "linux" ||
        Option.isNone(runtime) ||
        engineSessionId === null ||
        process.getuid === undefined
      )
        return yield* transportError(
          "unavailable",
          "The co-located Linux Jarvis host is not configured.",
        );
      if (
        request.id.length === 0 ||
        request.id.length > 512 ||
        !path.isAbsolute(runtime.value) ||
        request.params.binding.engineSessionId !== engineSessionId
      )
        return yield* transportError(
          "invalid_binding",
          "The native request belongs to another configured engine.",
        );
      const directory = path.join(runtime.value, "jarvis-native");
      const socketPath = path.join(directory, "jarvis-v1.sock");
      const uid = process.getuid();
      for (const [entry, type, mode] of [
        [runtime.value, "Directory", 0o700],
        [directory, "Directory", 0o700],
        [socketPath, "Socket", 0o600],
      ] as const) {
        const info = yield* fs
          .stat(entry)
          .pipe(
            Effect.mapError(() =>
              transportError("unavailable", "The private native endpoint is unavailable."),
            ),
          );
        if (
          info.type !== type ||
          Option.getOrNull(info.uid) !== uid ||
          (info.mode & 0o777) !== mode
        )
          return yield* transportError(
            "unavailable",
            "The native endpoint must be private and owned by this OS user.",
          );
      }
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(JarvisNativeRequest))(
        request,
      ).pipe(
        Effect.mapError(() =>
          transportError("invalid_binding", "Invalid canonical native request."),
        ),
      );
      if (new TextEncoder().encode(encoded).byteLength + 1 > MAX_FRAME)
        return yield* transportError("invalid_frame", "Native request exceeds its bound.");
      const socket = yield* NodeSocket.makeNet({ path: socketPath, openTimeout: 5_000 });
      const reader = yield* socket.reader.pipe(
        Effect.mapError(() =>
          transportError("unavailable", "The native host connection could not be opened."),
        ),
      );
      const writer = yield* socket.writer;
      yield* writer.write(encoded + "\n").pipe(Effect.mapError(unknownOutcome));
      const next = frameReader(reader);
      const response = yield* next.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(JarvisNativeResponse)),
        Effect.mapError(() => unknownOutcome()),
      );
      if (response.id !== request.id)
        return yield* transportError(
          "outcome_unknown",
          "Native response identity differs; reconcile the existing request/job.",
        );
      return { response, next };
    });
  return JarvisClient.of({
    engineSessionId,
    call: (request) =>
      connect(request).pipe(
        Effect.map(({ response }) => response),
        Effect.scoped,
        Effect.timeoutOrElse({ duration: 35_000, orElse: () => Effect.fail(unknownOutcome()) }),
      ),
    subscribe: (request) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { response, next } = yield* connect(request).pipe(
            Effect.timeoutOrElse({ duration: 35_000, orElse: () => Effect.fail(unknownOutcome()) }),
          );
          const ack: Stream.Stream<
            JarvisNativeResponse | JarvisNativeNotification,
            JarvisTransportError
          > = Stream.make(response);
          if ("error" in response) return ack;
          return Stream.concat(
            ack,
            Stream.fromEffectRepeat(
              next.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(JarvisNativeNotification)),
                Effect.mapError(() =>
                  transportError(
                    "invalid_frame",
                    "Invalid native notification; reconnect with an atomic snapshot.",
                  ),
                ),
              ),
            ),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(JarvisClient, make);
