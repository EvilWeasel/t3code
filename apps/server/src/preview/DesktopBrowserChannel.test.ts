// @effect-diagnostics nodeBuiltinImport:off - Exercises the real inherited descriptor lifecycle in a subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import type { DesktopBrowserPrivateEntryResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { makePrivateEntryRouter } from "./DesktopBrowserChannel.ts";

it("receives desktop messages and exits while the parent keeps both input pipes open", async () => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodeURL.fileURLToPath(new URL("./testing/DesktopPipeLifecycle.fixture.ts", import.meta.url))],
    { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"] },
  );
  // A failed exit must not leave a test process running. This never fires on success.
  // @effect-diagnostics-next-line globalTimers:off -- Bounds the native subprocess on failure; success waits for process exit.
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 8_000);
  let output = "";
  let errors = "";
  let verified = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const write = (fd: number, value: Record<string, unknown>) => {
    const stream = child.stdio[fd];
    if (!stream || !("write" in stream)) throw new Error(`Missing pipe ${fd}`);
    stream.write(`${JSON.stringify(value)}\n`);
  };
  const key = { threadId: "thread-1", tabId: "tab-1" };
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    let end: number;
    while ((end = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      if (line === "ready") {
        write(3, { type: "attached", ...key });
        write(5, { version: 1, type: "desktopTelemetryHello", electronPid: process.pid });
      } else if (line === "attached") {
        write(3, { type: "detached", ...key });
      } else if (line === "verified") {
        verified = true;
      }
    }
  });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    expect(errors).not.toContain("Error");
    expect(verified).toBe(true);
    expect(result).toEqual({ code: 0, signal: null });
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const stream of child.stdio) stream?.destroy();
  }
});

const privateTarget = {
  threadId: "thread",
  tabId: "tab",
  channelEpoch: "connection-a",
  attachmentId: "document-a",
};
effectIt.effect(
  "private control requires both advertised attachment and registered authority",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replies = yield* Queue.unbounded<DesktopBrowserPrivateEntryResponse>();
        const router = yield* makePrivateEntryRouter((response) =>
          Queue.offer(replies, response).pipe(Effect.as(true)),
        );
        const request = {
          ...privateTarget,
          type: "private-entry-acquire" as const,
          requestId: "acquire",
        };
        yield* router.attach(privateTarget);
        yield* router.receive(request);
        expect(yield* Queue.take(replies)).toMatchObject({
          type: "private-entry-refused",
          reason: "stale",
        });
        yield* router.attach(privateTarget, privateTarget);
        yield* router.receive(request);
        expect(yield* Queue.take(replies)).toMatchObject({
          type: "private-entry-refused",
          reason: "unavailable",
        });
      }),
    ),
);

effectIt.effect(
  "replacement and EOF invalidate exact attachment and fence late grants and release ACKs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replies = yield* Queue.unbounded<DesktopBrowserPrivateEntryResponse>();
        const invalidated = yield* Queue.unbounded<string>();
        const requests = yield* Queue.unbounded<string>();
        const router = yield* makePrivateEntryRouter((response) =>
          Queue.offer(replies, response).pipe(Effect.as(true)),
        );
        yield* router.registerPrivateEntryHandler({
          request: (request) => Queue.offer(requests, request.requestId).pipe(Effect.asVoid),
          invalidate: (target) => Queue.offer(invalidated, target.attachmentId).pipe(Effect.asVoid),
        });
        yield* router.attach(privateTarget, privateTarget);
        yield* router.receive({
          ...privateTarget,
          type: "private-entry-acquire",
          requestId: "first",
        });
        expect(yield* Queue.take(requests)).toBe("first");
        const replacement = {
          ...privateTarget,
          channelEpoch: "connection-b",
          attachmentId: "document-b",
        };
        yield* router.attach(replacement, replacement);
        expect(yield* Queue.take(invalidated)).toBe("document-a");
        // An old close must not detach the replacement.
        yield* router.detach(privateTarget, privateTarget);
        expect(yield* router.isCurrentPrivateEntryAttachment(replacement)).toBe(true);
        const late = { ...privateTarget, requestId: "first", leaseId: "old-lease", generation: 1 };
        expect(yield* router.sendPrivateEntry({ ...late, type: "private-entry-granted" })).toBe(
          false,
        );
        expect(
          yield* router.sendPrivateEntry({
            ...late,
            type: "private-entry-released",
            requestId: "release-old",
          }),
        ).toBe(false);
        expect(yield* Queue.clear(replies)).toEqual([]);
        yield* router.close;
        expect(yield* Queue.take(invalidated)).toBe("document-b");
        expect(yield* router.isCurrentPrivateEntryAttachment(replacement)).toBe(false);
        expect(
          yield* router.sendPrivateEntry({
            ...replacement,
            requestId: "late",
            leaseId: "lease",
            generation: 1,
            type: "private-entry-granted",
          }),
        ).toBe(false);
        yield* router.close;
        expect(yield* Queue.clear(invalidated)).toEqual([]);
      }),
    ),
);
