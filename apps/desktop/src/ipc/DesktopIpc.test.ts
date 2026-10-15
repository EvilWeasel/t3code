import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import * as DesktopIpc from "./DesktopIpc.ts";

const invokeMethod: DesktopIpc.DesktopIpcMethod<never, never> = {
  channel: "desktop.test.invoke",
  handler: () => Effect.void,
};

const syncMethod: DesktopIpc.DesktopSyncIpcMethod<never, never> = {
  channel: "desktop.test.sync",
  handler: () => Effect.void,
};

function makeIpcMain(
  overrides: Partial<DesktopIpc.DesktopIpcMain> = {},
): DesktopIpc.DesktopIpcMain {
  return {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

describe("DesktopIpc", () => {
  it.effect("preserves invoke registration context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("invoke registration failed");
      const ipcMain = makeIpcMain({
        handle: () => {
          throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain);

      const error = yield* Effect.flip(Effect.scoped(ipc.handle(invokeMethod)));

      assert.instanceOf(error, DesktopIpc.DesktopIpcRegistrationError);
      assert.strictEqual(error.handlerKind, "invoke");
      assert.strictEqual(error.channel, invokeMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "invoke");
      assert.include(error.message, invokeMethod.channel);
      assert.notInclude(error.message, cause.message);
    }),
  );

  it.effect("forwards the invoke sender to the method", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
      const ipc = DesktopIpc.make(
        makeIpcMain({
          handle: (_channel, registered) => {
            listener = registered;
          },
        }),
      );
      const sender = { sender: { id: 7 } };
      let received: DesktopIpc.DesktopIpcInvokeEvent | undefined;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handle({
            channel: "desktop.test.sender",
            handler: (_raw, event) =>
              Effect.sync(() => {
                received = event;
              }),
          });
          yield* Effect.promise(async () => listener!(sender, undefined));
        }),
      );

      assert.strictEqual(received, sender);
    }),
  );

  it.effect("preserves sync unregistration context and cause in the finalizer defect", () =>
    Effect.gen(function* () {
      const cause = new Error("sync unregistration failed");
      let removeCount = 0;
      const ipcMain = makeIpcMain({
        removeAllListeners: () => {
          removeCount += 1;
          if (removeCount === 2) throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain);

      const exit = yield* Effect.exit(Effect.scoped(ipc.handleSync(syncMethod)));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Success") return;
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, DesktopIpc.DesktopIpcUnregistrationError);
      assert.strictEqual(error.handlerKind, "sync");
      assert.strictEqual(error.channel, syncMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }),
  );
});

describe("DesktopIpc payload decoding options", () => {
  const payload = Schema.Struct({
    label: Schema.String,
    child: Schema.Struct({ allowed: Schema.Boolean }),
  });
  it.effect("strict opt-in rejects top-level and nested excess properties before the handler", () =>
    Effect.gen(function* () {
      let calls = 0;
      const method = DesktopIpc.makeIpcMethod({
        channel: "desktop.test.strict-payload",
        payload,
        result: Schema.Boolean,
        payloadDecodeOptions: { onExcessProperty: "error" },
        handler: () =>
          Effect.sync(() => {
            calls++;
            return true;
          }),
      });
      assert.equal(yield* method.handler({ label: "owned", child: { allowed: true } }), true);
      assert.equal(calls, 1);
      const top = yield* method
        .handler({ label: "owned", child: { allowed: true }, rawSettings: "refused" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(top));
      assert.equal(calls, 1);
      const nested = yield* method
        .handler({ label: "owned", child: { allowed: true, rawSettings: "refused" } })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(nested));
      assert.equal(calls, 1);
    }),
  );
  it.effect("absent options preserve legacy excess-field stripping and handler behavior", () =>
    Effect.gen(function* () {
      let observed: typeof payload.Type | undefined;
      const method = DesktopIpc.makeIpcMethod({
        channel: "desktop.test.legacy-payload",
        payload,
        result: Schema.Boolean,
        handler: (input) =>
          Effect.sync(() => {
            observed = input;
            return true;
          }),
      });
      assert.equal(
        yield* method.handler({
          label: "owned",
          child: { allowed: true, extra: "legacy" },
          extra: "legacy",
        }),
        true,
      );
      assert.deepEqual(observed, { label: "owned", child: { allowed: true } });
    }),
  );
});
