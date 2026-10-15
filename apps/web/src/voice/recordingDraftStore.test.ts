import { IDBFactory, IDBObjectStore as EmulatorObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Store = typeof import("./recordingDraftStore");

let connections: IDBDatabase[];

beforeEach(() => {
  vi.resetModules();
  connections = [];
  const factory = new IDBFactory();
  const open = factory.open.bind(factory);
  vi.spyOn(factory, "open").mockImplementation((...args) => {
    const request = open(...args);
    request.addEventListener("success", () => connections.push(request.result));
    return request;
  });
  vi.stubGlobal("indexedDB", factory);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const connection of connections) connection.close();
});

async function reloadStore(): Promise<Store> {
  // Keep the same IDBFactory and its committed transactions, discard module memory.
  vi.resetModules();
  return import("./recordingDraftStore");
}

async function commitQueuedWrites(store: Store): Promise<void> {
  // An uncached public read awaits the store's write chain, including commit/abort.
  expect(await store.readRecordingDraft("unused:commit-barrier")).toBeNull();
}

function recording(text: string, transcript: string) {
  return { audio: new Blob([text], { type: "audio/webm" }), transcript };
}

// This is an in-memory IndexedDB emulator test, not browser disk/process recovery.
describe("recording drafts across module resets with committed IndexedDB transactions", () => {
  it("recovers cloned audio and transcript independently of module memory and isolates targets", async () => {
    const store = await reloadStore();
    const first = recording("synthetic audio A", "First prompt");
    const second = recording("synthetic audio B", "Second prompt");
    store.writeRecordingDraft("environment:A:thread:one", first);
    store.writeRecordingDraft("environment:B:thread:one", second);
    await commitQueuedWrites(store);

    const fresh = await reloadStore();
    expect(fresh.readRecordingDraft).not.toBe(store.readRecordingDraft);
    const restored = await fresh.readRecordingDraft("environment:A:thread:one");
    expect(restored?.transcript).toBe("First prompt");
    expect(restored?.audio).toBeInstanceOf(Blob);
    expect(restored?.audio).not.toBe(first.audio);
    expect(restored?.audio.type).toBe("audio/webm");
    expect(await restored?.audio.text()).toBe("synthetic audio A");
    const other = await fresh.readRecordingDraft("environment:B:thread:one");
    expect(other?.transcript).toBe("Second prompt");
    expect(await other?.audio.text()).toBe("synthetic audio B");
    expect(await fresh.readRecordingDraft("environment:A:thread:other")).toBeNull();
  });

  it("keeps explicit removal committed across a module reset without removing another target", async () => {
    const store = await reloadStore();
    store.writeRecordingDraft("remove", recording("remove audio", "Remove"));
    store.writeRecordingDraft("retain", recording("retain audio", "Retain"));
    await commitQueuedWrites(store);
    const removing = await reloadStore();
    expect((await removing.readRecordingDraft("remove"))?.transcript).toBe("Remove");
    removing.writeRecordingDraft("remove", null);
    await commitQueuedWrites(removing);
    const fresh = await reloadStore();
    expect(await fresh.readRecordingDraft("remove")).toBeNull();
    expect((await fresh.readRecordingDraft("retain"))?.transcript).toBe("Retain");
  });

  it("retains failed audio in memory while an actual aborted transaction rolls back persisted data", async () => {
    const store = await reloadStore();
    store.writeRecordingDraft("target", recording("committed", "Committed"));
    await commitQueuedWrites(store);
    const aborted = Promise.withResolvers<void>();
    const put = EmulatorObjectStore.prototype.put;
    const intercepted = vi.spyOn(EmulatorObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      const request = put.apply(this, args);
      this.transaction.addEventListener("abort", () => aborted.resolve(), { once: true });
      request.addEventListener("success", () => this.transaction.abort(), { once: true });
      return request;
    });
    const failed = { ...recording("uncommitted", "Keep for retry"), message: "Retry available" };
    store.writeRecordingDraft("target", failed);
    await aborted.promise;
    await commitQueuedWrites(store);
    expect(await store.readRecordingDraft("target")).toBe(failed);
    intercepted.mockRestore();
    const fresh = await reloadStore();
    const restored = await fresh.readRecordingDraft("target");
    expect(restored?.transcript).toBe("Committed");
    expect(await restored?.audio.text()).toBe("committed");
    expect(restored).not.toHaveProperty("message");
  });

  it("serializes queued writes so cold reads recover the latest committed recording", async () => {
    const store = await reloadStore();
    store.writeRecordingDraft("target", recording("old", "Old"));
    const latest = recording("new", "New");
    store.writeRecordingDraft("target", latest);
    expect(await store.readRecordingDraft("target")).toBe(latest);
    await commitQueuedWrites(store);
    const fresh = await reloadStore();
    const restored = await fresh.readRecordingDraft("target");
    expect(restored?.transcript).toBe("New");
    expect(await restored?.audio.text()).toBe("new");
  });

  it("does not let a stale hydration result overwrite a new in-memory draft", async () => {
    const store = await reloadStore();
    store.writeRecordingDraft("target", recording("stored", "Stored"));
    await commitQueuedWrites(store);
    const fresh = await reloadStore();
    const latest = recording("replacement", "Replacement");
    const get = EmulatorObjectStore.prototype.get;
    const intercepted = vi.spyOn(EmulatorObjectStore.prototype, "get").mockImplementation(function (
      this: IDBObjectStore,
      key,
    ) {
      const request = get.call(this, key);
      if (key === "target") {
        // Register before the store's onsuccess: the old read completes while
        // a new capture synchronously establishes the authoritative draft.
        request.addEventListener("success", () => fresh.writeRecordingDraft("target", latest), {
          once: true,
        });
      }
      return request;
    });
    expect(await fresh.readRecordingDraft("target")).toBe(latest);
    intercepted.mockRestore();
    await commitQueuedWrites(fresh);
    const cold = await reloadStore();
    expect((await cold.readRecordingDraft("target"))?.transcript).toBe("Replacement");
  });
});
