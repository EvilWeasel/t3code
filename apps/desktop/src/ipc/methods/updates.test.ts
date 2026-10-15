import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { acknowledgeUpdateReadiness } from "./updates.ts";

describe("update readiness IPC", () => {
  it.effect("binds an acknowledgement to the current main frame and refuses unknown or subframe senders", () =>
    Effect.gen(function* () {
      const acknowledged = yield* Ref.make(0);
      const layers = Layer.mergeAll(
        Layer.mock(DesktopUpdates.DesktopUpdates)({
          acknowledgeReadiness: () => Ref.update(acknowledged, (count) => count + 1).pipe(Effect.as(true)),
        }),
        Layer.mock(ElectronWindow.ElectronWindow)({
          updateInventory: Effect.succeed([{ id: 7, generation: "11:12", audible: false }]),
        }),
      );
      const payload = {
        lease: { generation: "install-1", targetVersion: "1.0.1", expiresAt: 20_000, phase: "prepare" },
        ready: true,
      };
      yield* Effect.gen(function* () {
        assert.equal(yield* acknowledgeUpdateReadiness.handler(payload), false);
        assert.equal(yield* acknowledgeUpdateReadiness.handler(payload, { sender: { id: 7 } }), false);
        assert.equal(yield* acknowledgeUpdateReadiness.handler(payload, {
          sender: { id: 7 }, senderFrame: { processId: 11, routingId: 12, parent: {} },
        }), false);
        assert.equal(yield* acknowledgeUpdateReadiness.handler(payload, {
          sender: { id: 7 }, senderFrame: { processId: 11, routingId: 99, parent: null },
        }), false);
        assert.equal(yield* acknowledgeUpdateReadiness.handler(payload, {
          sender: { id: 7 }, senderFrame: { processId: 11, routingId: 12, parent: null },
        }), true);
      }).pipe(Effect.provide(layers));
      assert.equal(yield* Ref.get(acknowledged), 1);
    }),
  );
});
