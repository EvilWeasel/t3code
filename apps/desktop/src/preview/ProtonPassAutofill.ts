import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ProtonLoginReference, ProtonPassProvider } from "./ProtonPassCli.ts";

export interface AutofillTarget {
  readonly origin: string;
  readonly partition: string;
  readonly privateEntry: boolean;
  current(): boolean;
  enterPrivate(): Promise<void>;
  holdPrivate(): () => void;
  fill(username: string, password: string): Promise<void>;
  clearAndResume(): Promise<void>;
}
export interface LinkedLogin extends ProtonLoginReference {
  readonly origin: string;
  readonly partition: string;
}
export interface BindingStore {
  read(): Promise<readonly LinkedLogin[]>;
  write(bindings: readonly LinkedLogin[]): Promise<void>;
}
export class AutofillUnavailable extends Data.TaggedError("AutofillUnavailable")<{
  readonly message: string;
}> {
  constructor() {
    super({
      message:
        "This login target changed or cannot be filled privately. Focus its main-frame login field and try again.",
    });
  }
}
export const validOrigin = (raw: string) => {
  try {
    const url = new URL(raw);
    return (
      url.origin === raw &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
};
const validBinding = (value: unknown): value is LinkedLogin => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    ["shareId", "itemId", "title", "origin", "partition"].every(
      (key) => typeof entry[key] === "string" && String(entry[key]).length <= 4096,
    ) &&
    validOrigin(String(entry.origin)) &&
    String(entry.partition).startsWith("persist:")
  );
};
const bindingJsonCodec = Schema.fromJsonString(Schema.Unknown);
const bindingIOLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const runBindingIO = async <A>(
  operation: Effect.Effect<A, AutofillUnavailable, FileSystem.FileSystem | Path.Path>,
) => {
  const result = await Effect.runPromise(
    operation.pipe(Effect.result, Effect.provide(bindingIOLayer)),
  );
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};
/** Stores references only. Secret fields are never serialized. */
export function makeBindingStore(file: string): BindingStore {
  return {
    read: () =>
      runBindingIO(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const raw = yield* fs
            .readFileString(file)
            .pipe(
              Effect.catch((error) =>
                error.reason._tag === "NotFound"
                  ? Effect.succeed(undefined)
                  : Effect.fail(new AutofillUnavailable()),
              ),
            );
          if (raw === undefined) return [];
          const parsed = yield* Schema.decodeUnknownEffect(bindingJsonCodec)(raw);
          return Array.isArray(parsed) ? parsed.filter(validBinding) : [];
        }).pipe(Effect.mapError(() => new AutofillUnavailable())),
      ),
    write: (bindings) =>
      runBindingIO(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const data = bindings.map(({ shareId, itemId, title, origin, partition }) => ({
            shareId,
            itemId,
            title,
            origin,
            partition,
          }));
          yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
          const temporary = `${file}.tmp`;
          const encoded = yield* Schema.encodeEffect(bindingJsonCodec)(data);
          yield* fs.writeFileString(temporary, encoded, { mode: 0o600 });
          yield* fs.rename(temporary, file);
        }).pipe(Effect.mapError(() => new AutofillUnavailable())),
      ),
  };
}
export function makeAutofill(provider: ProtonPassProvider, store: BindingStore) {
  let busy = false;
  const check = (target: AutofillTarget) => {
    if (
      !target.current() ||
      !validOrigin(target.origin) ||
      !target.partition.startsWith("persist:")
    )
      throw new AutofillUnavailable();
  };
  return {
    async linked(target: AutofillTarget) {
      check(target);
      return (await store.read()).filter(
        (entry) => entry.origin === target.origin && entry.partition === target.partition,
      );
    },
    async link(
      target: AutofillTarget,
      choose: (provider: ProtonPassProvider) => Promise<ProtonLoginReference | undefined>,
    ) {
      if (busy) throw new AutofillUnavailable();
      busy = true;
      try {
        check(target);
        await target.enterPrivate();
        check(target);
        const selected = await choose(provider);
        if (!selected) return;
        check(target);
        const entries = await store.read();
        check(target);
        await store.write([
          ...entries.filter(
            (entry) =>
              !(
                entry.partition === target.partition &&
                entry.origin === target.origin &&
                entry.itemId === selected.itemId &&
                entry.shareId === selected.shareId
              ),
          ),
          { ...selected, origin: target.origin, partition: target.partition },
        ]);
        return selected;
      } finally {
        busy = false;
      }
    },
    async clearAndResume(target: AutofillTarget) {
      // Refuse while metadata selection, a selected read, or native input is pending.
      if (busy) throw new AutofillUnavailable();
      busy = true;
      try {
        if (!target.current()) throw new AutofillUnavailable();
        await target.clearAndResume();
      } finally {
        busy = false;
      }
    },
    async unlink(target: AutofillTarget, reference: ProtonLoginReference) {
      if (busy) throw new AutofillUnavailable();
      busy = true;
      try {
        check(target);
        const entries = await store.read();
        check(target);
        await store.write(
          entries.filter(
            (entry) =>
              !(
                entry.origin === target.origin &&
                entry.partition === target.partition &&
                entry.shareId === reference.shareId &&
                entry.itemId === reference.itemId
              ),
          ),
        );
      } finally {
        busy = false;
      }
    },
    async fill(target: AutofillTarget, reference: ProtonLoginReference) {
      if (busy) throw new AutofillUnavailable();
      busy = true;
      try {
        check(target);
        const linked = (await store.read()).some(
          (entry) =>
            entry.partition === target.partition &&
            entry.origin === target.origin &&
            entry.itemId === reference.itemId &&
            entry.shareId === reference.shareId,
        );
        if (!linked) throw new AutofillUnavailable();
        check(target);
        await target.enterPrivate();
        check(target);
        const release = target.holdPrivate();
        try {
          const credentials = await provider.credentials(reference);
          check(target);
          await target.fill(credentials.username, credentials.password);
        } finally {
          release();
        }
      } finally {
        busy = false;
      }
    },
  };
}
