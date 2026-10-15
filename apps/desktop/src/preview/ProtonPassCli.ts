import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export type ProtonPassState = "missing" | "unsupported" | "locked" | "signed-out" | "unavailable";
export class ProtonPassUnavailable extends Error {
  readonly state: ProtonPassState;
  constructor(state: ProtonPassState) {
    super(
      state === "missing" || state === "unsupported"
        ? "Proton Pass CLI is missing or unsupported. This integration requires CLI 2.4.2 installed on this desktop."
        : state === "locked" || state === "signed-out"
          ? `Proton Pass CLI is ${state}. Unlock or sign in to the CLI explicitly; the desktop app uses a separate session.`
          : "Proton Pass CLI is unavailable. Check its local installation and CLI session, then try again.",
    );
    this.state = state;
  }
}
export interface ProtonLoginReference {
  readonly shareId: string;
  readonly itemId: string;
  readonly title: string;
}
export interface ProtonPassProvider {
  vaults(): Promise<readonly { shareId: string; title: string }[]>;
  logins(shareId: string): Promise<readonly ProtonLoginReference[]>;
  credentials(reference: ProtonLoginReference): Promise<{ username: string; password: string }>;
}
export type RunProtonPass = (args: readonly string[]) => Promise<string>;

/** stdout is consumed privately; neither provider output nor errors enter app logs. */
export const runProtonPassEffect = (args: readonly string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner
        .spawn(
          ChildProcess.make("pass-cli", [...args], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            shell: false,
            killSignal: "SIGTERM",
            forceKillAfter: "1 second",
          }),
        )
        .pipe(Effect.mapError(() => new ProtonPassUnavailable("missing")));
      let stdout = "";
      let stderr = "";
      const [, , code] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runForEach((text) => {
              stdout += text;
              return stdout.length > 1024 * 1024
                ? Effect.fail(new ProtonPassUnavailable("unavailable"))
                : Effect.void;
            }),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((text) =>
              Effect.sync(() => {
                stderr = (stderr + text).slice(0, 4096);
              }),
            ),
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* Effect.fail(
          new ProtonPassUnavailable(
            /locked|lock code|keyring/i.test(stderr)
              ? "locked"
              : /authenticated client|not logged|no session/i.test(stderr)
                ? "signed-out"
                : "unavailable",
          ),
        );
      return stdout;
    }),
  ).pipe(
    // Interrupting the scope kills the captured child, including on output overflow or timeout.
    Effect.timeout("15 seconds"),
    Effect.mapError((error) =>
      error instanceof ProtonPassUnavailable ? error : new ProtonPassUnavailable("unavailable"),
    ),
  );
const cliProcessLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);
export const runProtonPass: RunProtonPass = async (args) => {
  const result = await Effect.runPromise(
    runProtonPassEffect(args).pipe(Effect.result, Effect.provide(cliProcessLayer)),
  );
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const parse = (raw: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(raw);
    if (record(value)) return value;
  } catch {}
  throw new ProtonPassUnavailable("unsupported");
};
const field = (raw: string) => (raw.endsWith("\n") ? raw.slice(0, -1) : raw);

export function makeProtonPassProvider(run: RunProtonPass = runProtonPass): ProtonPassProvider {
  const ready = async () => {
    if (!/^Proton Pass CLI 2\.4\.2\b/.test(await run(["--version"])))
      throw new ProtonPassUnavailable("unsupported");
  };
  return {
    async vaults() {
      await ready();
      const entries = parse(await run(["vault", "list", "--output", "json"])).vaults;
      if (!Array.isArray(entries)) throw new ProtonPassUnavailable("unsupported");
      return entries
        .filter(record)
        .filter((entry) => text(entry.share_id) && text(entry.name))
        .map((entry) => ({ shareId: String(entry.share_id), title: String(entry.name) }));
    },
    async logins(shareId) {
      await ready();
      const entries = parse(
        await run([
          "item",
          "list",
          "--share-id",
          shareId,
          "--filter-type",
          "login",
          "--filter-state",
          "active",
          "--output",
          "json",
        ]),
      ).items;
      if (!Array.isArray(entries)) throw new ProtonPassUnavailable("unsupported");
      return entries
        .filter(record)
        .filter(
          (entry) =>
            entry.item_type === "login" &&
            entry.share_id === shareId &&
            text(entry.id) &&
            text(entry.title),
        )
        .map((entry) => ({ shareId, itemId: String(entry.id), title: String(entry.title) }));
    },
    async credentials(reference) {
      await ready();
      const read = (name: string) =>
        run([
          "item",
          "view",
          "--share-id",
          reference.shareId,
          "--item-id",
          reference.itemId,
          "--field",
          name,
        ]).then(field);
      const username = await read("username");
      const password = await read("password");
      if (!password || username.length > 65536 || password.length > 65536)
        throw new ProtonPassUnavailable("unavailable");
      return { username, password };
    },
  };
}
