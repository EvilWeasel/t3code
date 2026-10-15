import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
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
export class AutofillUnavailable extends Error {
  constructor() {
    super(
      "This login target changed or cannot be filled privately. Focus its main-frame login field and try again.",
    );
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
/** Stores references only. Secret fields are never serialized. */
export function makeBindingStore(file: string): BindingStore {
  return {
    async read() {
      try {
        const parsed: unknown = JSON.parse(await NodeFSP.readFile(file, "utf8"));
        if (Array.isArray(parsed)) return parsed.filter(validBinding);
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw new AutofillUnavailable();
      }
      return [];
    },
    async write(bindings) {
      const data = bindings.map(({ shareId, itemId, title, origin, partition }) => ({
        shareId,
        itemId,
        title,
        origin,
        partition,
      }));
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      await NodeFSP.writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
      await NodeFSP.rename(temporary, file);
    },
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
