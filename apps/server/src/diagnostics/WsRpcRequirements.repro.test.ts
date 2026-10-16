import { expectTypeOf, it } from "@effect/vitest";
import { RpcScopeAuthorization } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type { WsRpcInferenceBoundary } from "../ws.ts";

const finiteGroup = RpcGroup.make(
  Rpc.make("repro.ws.read", { payload: Schema.Struct({}), success: Schema.String }),
  Rpc.make("repro.ws.events", {
    payload: Schema.Struct({}),
    success: Schema.String,
    stream: true,
  }),
).middleware(RpcScopeAuthorization);
const finiteBuilder = Effect.gen(function* () {
  const path = yield* Path.Path;
  const read = Effect.map(FileSystem.FileSystem, () => path.join("fixture", "result"));
  return finiteGroup.of({
    "repro.ws.read": () => read,
    "repro.ws.events": () => Stream.fromEffect(read),
  });
});
const finiteLayer = finiteGroup.toLayer(finiteBuilder);
type FiniteRpcs = RpcGroup.Rpcs<typeof finiteGroup>;
type FiniteHandlers = Effect.Success<typeof finiteBuilder>;
type FiniteMapped = RpcGroup.HandlersServices<FiniteRpcs, FiniteHandlers>;

it("finite public API: builder RX is exactly Path", () => {
  expectTypeOf<Effect.Services<typeof finiteBuilder>>().toEqualTypeOf<Path.Path>();
});
it("finite public API: unary and stream handler requirements are exactly FileSystem", () => {
  expectTypeOf<
    RpcGroup.HandlerServices<FiniteRpcs, "repro.ws.read", FiniteHandlers["repro.ws.read"]>
  >().toEqualTypeOf<FileSystem.FileSystem>();
  expectTypeOf<
    RpcGroup.HandlerServices<FiniteRpcs, "repro.ws.events", FiniteHandlers["repro.ws.events"]>
  >().toEqualTypeOf<FileSystem.FileSystem>();
});
it("finite public API: mapped union is exactly FileSystem", () => {
  expectTypeOf<FiniteMapped>().toEqualTypeOf<FileSystem.FileSystem>();
});
it("finite public API: toLayer retains both builder and handler dependencies", () => {
  expectTypeOf<Layer.Services<typeof finiteLayer>>().toEqualTypeOf<
    Path.Path | FileSystem.FileSystem
  >();
});

type ActualRpcs = WsRpcInferenceBoundary["rpcs"];
type ActualHandlers = WsRpcInferenceBoundary["handlers"];
type ActualTags = ActualRpcs["_tag"];
it("actual input: RPC union is neither any nor never and H keyspace matches exact instrumented tags", () => {
  expectTypeOf<ActualRpcs>().not.toBeAny();
  expectTypeOf<ActualRpcs>().not.toBeNever();
  expectTypeOf<keyof ActualHandlers>().toEqualTypeOf<ActualTags>();
});
it("actual mapped dependency: public HandlersServices over exact R and H is not any", () => {
  expectTypeOf<RpcGroup.HandlersServices<ActualRpcs, ActualHandlers>>().not.toBeAny();
});
