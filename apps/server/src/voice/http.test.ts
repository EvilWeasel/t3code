import { expect, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AuthHttp from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as VoiceService from "./VoiceTranscriptionService.ts";
import * as VoiceHttp from "./http.ts";

class VoiceTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.voice) {}

const handlerFor = (scopes: ReadonlyArray<string>, fail = false) => {
  let received: VoiceService.VoiceAudio | undefined;
  const auth = {
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("voice-test"),
        subject: "voice-test",
        method: "bearer-access-token",
        scopes,
      }),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
  const service = {
    transcribe: (audio: VoiceService.VoiceAudio) => {
      received = audio;
      return fail
        ? Effect.fail(
            new VoiceService.VoiceTranscriptionError({
              reason: "upstream_forbidden",
              detail: "Upstream rejected transcription.",
              status: 403,
            }),
          )
        : Effect.succeed("");
    },
  };
  const layer = HttpApiBuilder.layer(VoiceTestApi).pipe(
    Layer.provide(VoiceHttp.layer),
    Layer.provide(Layer.succeed(VoiceService.VoiceTranscriptionService, service)),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
    Layer.provide(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  const web = HttpRouter.toWebHandler(layer, { disableLogger: true });
  return { ...web, received: () => received };
};

const postAudio = async (
  handler: (
    request: Request,
    context: Context.Context<FileSystem.FileSystem | Path.Path>,
  ) => Promise<Response>,
  context: Context.Context<FileSystem.FileSystem | Path.Path>,
) => {
  const form = new FormData();
  form.set("audio", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), "clip.webm");
  return handler(
    new Request("http://environment.test/api/voice/transcription", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: form,
    }),
    context,
  );
};

it.effect(
  "authenticates destination requests, enforces operation scope, and accepts multipart audio",
  () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const denied = handlerFor(["orchestration:read"]);
      const deniedResponse = yield* Effect.promise(() => postAudio(denied.handler, context));
      expect(deniedResponse.status).toBe(403);
      yield* Effect.promise(() => denied.dispose());

      const allowed = handlerFor(["orchestration:operate"]);
      const response = yield* Effect.promise(() => postAudio(allowed.handler, context));
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({ transcript: "" });
      expect(allowed.received()?.contentType).toBe("audio/webm");
      expect(allowed.received()?.fileName).toBe("clip.webm");
      expect([...allowed.received()!.bytes]).toEqual([1, 2, 3]);
      yield* Effect.promise(() => allowed.dispose());
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("maps provider failures to the bounded typed HTTP error", () =>
  Effect.gen(function* () {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const route = handlerFor(["orchestration:operate"], true);
    const response = yield* Effect.promise(() => postAudio(route.handler, context));
    expect(response.status).toBe(502);
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      _tag: "VoiceTranscriptionHttpError",
      code: "voice_transcription_failed",
      reason: "upstream_forbidden",
      detail: "Upstream rejected transcription.",
    });
    yield* Effect.promise(() => route.dispose());
  }).pipe(Effect.provide(NodeServices.layer)),
);
