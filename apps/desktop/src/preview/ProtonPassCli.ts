import * as NodeChildProcess from "node:child_process";

export type ProtonPassState = "missing" | "unsupported" | "locked" | "signed-out" | "unavailable";
export class ProtonPassUnavailable extends Error {
  constructor(readonly state: ProtonPassState) {
    super(
      state === "missing" || state === "unsupported"
        ? "Proton Pass CLI is missing or unsupported. This integration requires CLI 2.4.2 installed on this desktop."
        : state === "locked" || state === "signed-out"
          ? `Proton Pass CLI is ${state}. Unlock or sign in to the CLI explicitly; the desktop app uses a separate session.`
          : "Proton Pass CLI is unavailable. Check its local installation and CLI session, then try again.",
    );
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
export const runProtonPass: RunProtonPass = (args) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("pass-cli", [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let failed = false;
    const fail = (state: ProtonPassState) => {
      if (failed) return;
      failed = true;
      child.kill();
      reject(new ProtonPassUnavailable(state));
    };
    const timer = setTimeout(() => fail("unavailable"), 15000);
    child.stdout.on("data", (bytes: Buffer) => {
      stdout += bytes.toString();
      if (stdout.length > 1024 * 1024) fail("unavailable");
    });
    child.stderr.on("data", (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(0, 4096);
    });
    child.once("error", () => {
      clearTimeout(timer);
      fail("missing");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) {
        fail(
          /locked|lock code|keyring/i.test(stderr)
            ? "locked"
            : /authenticated client|not logged|no session/i.test(stderr)
              ? "signed-out"
              : "unavailable",
        );
        return;
      }
      resolve(stdout);
    });
  });
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
