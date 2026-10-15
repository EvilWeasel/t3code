import * as Effect from "effect/Effect";

import * as JarvisService from "../../../integrations/jarvis/JarvisService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { JarvisToolkit } from "./tools.ts";

const handlers = {
  jarvis_catalog: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      return yield* (yield* JarvisService.JarvisService).catalog(
        yield* McpInvocationContext.McpInvocationContext,
      );
    }),
  ),
  jarvis_observe: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* JarvisService.JarvisService).observe(
        yield* McpInvocationContext.McpInvocationContext,
        input,
      );
    }),
  ),
  jarvis_prepare: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* JarvisService.JarvisService).prepare(
        yield* McpInvocationContext.McpInvocationContext,
        input.invocation,
      );
    }),
  ),
  jarvis_submit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* JarvisService.JarvisService).submit(
        yield* McpInvocationContext.McpInvocationContext,
        input,
      );
    }),
  ),
  jarvis_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* JarvisService.JarvisService).status(
        yield* McpInvocationContext.McpInvocationContext,
        input,
      );
    }),
  ),
  jarvis_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* JarvisService.JarvisService).cancel(
        yield* McpInvocationContext.McpInvocationContext,
        input,
      );
    }),
  ),
  jarvis_events: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* JarvisService.JarvisService).events(
        yield* McpInvocationContext.McpInvocationContext,
        input,
      );
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof JarvisToolkit.tools>;

export const layer = McpToolAccess.toLayer(JarvisToolkit, handlers);
