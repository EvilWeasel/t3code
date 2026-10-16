import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  importComposerThreadAttachment,
  remainingComposerAttachmentSlots,
} from "./composerThreadImport";

function deferred<T>() {
  const completion: {
    resolve?: (value: T | PromiseLike<T>) => void;
    reject?: (error: Error) => void;
  } = {};
  const promise = new Promise<T>((resolve, reject) => {
    completion.resolve = resolve;
    completion.reject = reject;
  });
  const { resolve, reject } = completion;
  if (resolve === undefined || reject === undefined)
    throw new Error("Deferred gate was not initialized");
  return { promise, resolve, reject };
}

function file(name: string) {
  return new File([name], name, { type: "application/x-ndjson" });
}

function unexpectedLimit() {
  throw new Error("An attachment slot should be available");
}

describe("importComposerThreadAttachment", () => {
  it.each([PROVIDER_SEND_TURN_MAX_ATTACHMENTS, PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1])(
    "refuses admission at %i reserved attachments before loading or changing reservations",
    async (reserved) => {
      const pendingImports = new Map([["other-draft", 2]]);
      const load = vi.fn(async () => file("not-loaded.jsonl"));
      const attach = vi.fn(async (_file: File) => true);
      const onLimitReached = vi.fn();
      await importComposerThreadAttachment({
        targetKey: "draft",
        pendingImports,
        countReservedAttachments: () => reserved,
        load,
        isActive: () => true,
        attach,
        onLimitReached,
      });
      expect(onLimitReached).toHaveBeenCalledTimes(1);
      expect(load).not.toHaveBeenCalled();
      expect(attach).not.toHaveBeenCalled();
      expect([...pendingImports]).toEqual([["other-draft", 2]]);
    },
  );

  it("reserves the final slot synchronously so repeated concurrent drops cannot load", async () => {
    const pendingImports = new Map<string, number>();
    const transcript = deferred<File>();
    const load = vi.fn(() => transcript.promise);
    const attach = vi.fn(async (_file: File) => true);
    const onLimitReached = vi.fn();
    const input = {
      targetKey: "draft",
      pendingImports,
      countReservedAttachments: () =>
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 + (pendingImports.get("draft") ?? 0),
      load,
      isActive: () => true,
      attach,
      onLimitReached,
    };
    const first = importComposerThreadAttachment(input);
    expect(pendingImports.get("draft")).toBe(1);
    await Promise.all([
      importComposerThreadAttachment(input),
      importComposerThreadAttachment(input),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onLimitReached).toHaveBeenCalledTimes(2);
    expect(attach).not.toHaveBeenCalled();

    const transcriptFile = file("first.jsonl");
    transcript.resolve(transcriptFile);
    await first;
    expect(attach).toHaveBeenCalledExactlyOnceWith(transcriptFile);
    expect(pendingImports.size).toBe(0);
  });

  it("releases only the completed import's slot while the second import stays reserved", async () => {
    const pendingImports = new Map([["other-draft", 3]]);
    const first = deferred<File>();
    const second = deferred<File>();
    const attached: string[] = [];
    const attachedReservations: number[] = [];
    const countReservedAttachments = () =>
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 2 + attached.length + (pendingImports.get("draft") ?? 0);
    const attach = async (attachment: File) => {
      attachedReservations.push(pendingImports.get("draft") ?? 0);
      if (countReservedAttachments() >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) return false;
      attached.push(attachment.name);
      return true;
    };
    const input = {
      targetKey: "draft",
      pendingImports,
      countReservedAttachments,
      isActive: () => true,
      attach,
      onLimitReached: unexpectedLimit,
    };
    const firstImport = importComposerThreadAttachment({ ...input, load: () => first.promise });
    const secondImport = importComposerThreadAttachment({ ...input, load: () => second.promise });
    expect(pendingImports.get("draft")).toBe(2);

    first.resolve(file("first.jsonl"));
    await firstImport;
    expect(pendingImports.get("draft")).toBe(1);
    expect(pendingImports.get("other-draft")).toBe(3);
    expect(attached).toEqual(["first.jsonl"]);
    expect(countReservedAttachments()).toBe(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);

    second.resolve(file("second.jsonl"));
    await secondImport;
    expect(attached).toEqual(["first.jsonl", "second.jsonl"]);
    expect(attachedReservations).toEqual([1, 0]);
    expect([...pendingImports]).toEqual([["other-draft", 3]]);
  });

  it("releases its reservation before attach so the final slot can actually be filled", async () => {
    const pendingImports = new Map<string, number>();
    const transcript = deferred<File>();
    const attached: File[] = [];
    const importing = importComposerThreadAttachment({
      targetKey: "draft",
      pendingImports,
      countReservedAttachments: () =>
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS -
        1 +
        attached.length +
        (pendingImports.get("draft") ?? 0),
      load: () => transcript.promise,
      isActive: () => true,
      attach: async (attachment) => {
        expect(pendingImports.has("draft")).toBe(false);
        const slots = remainingComposerAttachmentSlots(
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 + attached.length,
          pendingImports.get("draft") ?? 0,
        );
        if (slots === 0) return false;
        attached.push(attachment);
        return true;
      },
      onLimitReached: unexpectedLimit,
    });
    expect(pendingImports.get("draft")).toBe(1);
    const transcriptFile = file("final-slot.jsonl");
    transcript.resolve(transcriptFile);
    await importing;
    expect(attached).toEqual([transcriptFile]);
    expect(pendingImports.size).toBe(0);
  });

  it.each(["load", "attach"])(
    "propagates the exact %s rejection while releasing only its own reservation",
    async (stage) => {
      const pendingImports = new Map([
        ["draft", 1],
        ["other-draft", 2],
      ]);
      const transcript = deferred<File>();
      const attachment = deferred<boolean>();
      const attaching = deferred<void>();
      const failure = new Error(`Synthetic ${stage} failure`);
      const attach = vi.fn((_file: File) => {
        attaching.resolve(undefined);
        return attachment.promise;
      });
      const importing = importComposerThreadAttachment({
        targetKey: "draft",
        pendingImports,
        countReservedAttachments: () => pendingImports.get("draft") ?? 0,
        load: () => transcript.promise,
        isActive: () => true,
        attach,
        onLimitReached: unexpectedLimit,
      });
      expect(pendingImports.get("draft")).toBe(2);
      const rejected = expect(importing).rejects.toBe(failure);
      if (stage === "load") {
        transcript.reject(failure);
      } else {
        transcript.resolve(file("attachment.jsonl"));
        await attaching.promise;
        expect(pendingImports.get("draft")).toBe(1);
        attachment.reject(failure);
      }
      await rejected;
      expect(attach).toHaveBeenCalledTimes(stage === "load" ? 0 : 1);
      expect([...pendingImports]).toEqual([
        ["draft", 1],
        ["other-draft", 2],
      ]);
    },
  );

  it.each(["inactive", "replaced-target"])(
    "does not attach after %s and frees the original target without touching the replacement",
    async (change) => {
      const pendingImports = new Map([["replacement", 2]]);
      const transcript = deferred<File>();
      const attach = vi.fn(async (_file: File) => true);
      let active = true;
      let currentTarget = "original";
      const importing = importComposerThreadAttachment({
        targetKey: "original",
        pendingImports,
        countReservedAttachments: () => pendingImports.get("original") ?? 0,
        load: () => transcript.promise,
        isActive: () => active && currentTarget === "original",
        attach,
        onLimitReached: unexpectedLimit,
      });
      expect(pendingImports.get("original")).toBe(1);
      if (change === "inactive") active = false;
      else currentTarget = "replacement";
      transcript.resolve(file("stale.jsonl"));
      await importing;
      expect(attach).not.toHaveBeenCalled();
      expect([...pendingImports]).toEqual([["replacement", 2]]);
    },
  );
});

describe("remainingComposerAttachmentSlots", () => {
  it.each([
    { attachments: 0, pending: 0, expected: PROVIDER_SEND_TURN_MAX_ATTACHMENTS },
    { attachments: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 3, pending: 1, expected: 2 },
    { attachments: PROVIDER_SEND_TURN_MAX_ATTACHMENTS, pending: 0, expected: 0 },
    { attachments: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1, pending: 1, expected: 0 },
    { attachments: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1, pending: 0, expected: 0 },
    { attachments: 0, pending: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1, expected: 0 },
  ])(
    "reports $expected slots for $attachments attachments and $pending imports",
    ({ attachments, pending, expected }) => {
      expect(remainingComposerAttachmentSlots(attachments, pending)).toBe(expected);
    },
  );
});
