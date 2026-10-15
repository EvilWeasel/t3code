import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("verifies real deferred draft storage bytes and refuses readback, write failure and unpersisted files", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  const bytes = new Map<string, string>();
  let throwWrite = false;
  let corruptReadback = false;
  const storage = {
    getItem: (key: string) => corruptReadback ? "invalid readback" : bytes.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (throwWrite) throw new Error("fixture storage quota exceeded");
      bytes.set(key, value);
    },
    removeItem: (key: string) => { bytes.delete(key); },
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage, addEventListener: () => {} });
  // The real module constructs createDeferredStorage against this storage;
  // neither the draft store nor its serializer/flush function is mocked.
  const { useComposerDraftStore, flushAndVerifyComposerDrafts, COMPOSER_DRAFT_STORAGE_KEY } =
    await import("../composerDraftStore");
  const target = scopeThreadRef(EnvironmentId.make("update-storage-env"), ThreadId.make("update-storage-thread"));
  useComposerDraftStore.getState().setPrompt(target, "Retain this unsent draft exactly.");
  expect(flushAndVerifyComposerDrafts()).toBe(true);
  expect(bytes.get(COMPOSER_DRAFT_STORAGE_KEY)).toContain("Retain this unsent draft exactly.");
  corruptReadback = true;
  expect(flushAndVerifyComposerDrafts()).toBe(false);
  corruptReadback = false;
  useComposerDraftStore.getState().setPrompt(target, "This newer draft must not be lost.");
  throwWrite = true;
  expect(flushAndVerifyComposerDrafts()).toBe(false);
  throwWrite = false;
  const file = new File(["not uploaded"], "notes.txt", { type: "text/plain" });
  useComposerDraftStore.getState().addFiles(target, [{
    type: "file", id: "pending-update-file", name: file.name, mimeType: file.type,
    sizeBytes: file.size, file,
  }]);
  expect(flushAndVerifyComposerDrafts()).toBe(false);
});
