import { describe, expect, it, vi } from "vite-plus/test";

import { createCdpRelayConnection, type CdpRelayTarget } from "./CdpRelay.ts";

const makeTarget = (
  send: CdpRelayTarget["send"],
  setDownloadDirectory: CdpRelayTarget["setDownloadDirectory"] = () => {},
): CdpRelayTarget => ({
  send,
  targetId: async () => "GUEST-TARGET",
  url: () => "http://localhost:4719/",
  title: () => "Fixture",
  userAgent: () => "Electron",
  setDownloadDirectory,
});

// Each relay reply resolves after a few microtasks; one macrotask lets them all land.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("CDP relay", () => {
  it("announces only the tab's page, under its real target id", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(vi.fn()), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.createTarget", params: {} }));
    await settle();
    const attach = written.findIndex((message) => message["id"] === 1);
    // The page is announced right after the auto-attach reply, never before it.
    expect(written.slice(attach, attach + 2)).toEqual([
      { id: 1, result: {} },
      {
        method: "Target.attachedToTarget",
        params: expect.objectContaining({
          sessionId: "t3-preview-page",
          targetInfo: expect.objectContaining({ targetId: "GUEST-TARGET", type: "page" }),
        }),
      },
    ]);
    expect(written).toContainEqual({
      id: 2,
      error: expect.objectContaining({ message: expect.stringContaining("createTarget") }),
    });
  });

  it("forwards page commands to the tab and lets a slow one finish last", async () => {
    const pending: Array<() => void> = [];
    const send = vi.fn(
      (method: string) =>
        new Promise<unknown>((resolve) => pending.push(() => resolve({ method }))),
    );
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(send), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(
      JSON.stringify({ id: 5, method: "Page.captureScreenshot", sessionId: "t3-preview-page" }),
    );
    relay.receive(JSON.stringify({ id: 6, method: "DOM.enable", sessionId: "iframe-session" }));
    // A slow screenshot must not hold up the reply behind it.
    pending[1]!();
    await settle();
    expect(written).toEqual([
      { id: 6, result: { method: "DOM.enable" }, sessionId: "iframe-session" },
    ]);
    pending[0]!();
    await settle();
    expect(send).toHaveBeenNthCalledWith(1, "Page.captureScreenshot", {}, undefined);
    expect(send).toHaveBeenNthCalledWith(2, "DOM.enable", {}, "iframe-session");
    expect(written.at(-1)).toEqual({
      id: 5,
      result: { method: "Page.captureScreenshot" },
      sessionId: "t3-preview-page",
    });
  });

  it("resumes paused child frames, so cross-site iframes run", async () => {
    const send = vi.fn(async () => ({}));
    const relay = createCdpRelayConnection(makeTarget(send), () => {});
    // The page's own session is already running; only its children wait.
    relay.receive(
      JSON.stringify({
        id: 1,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "t3-preview-page",
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "iframe-session",
      }),
    );
    await settle();
    expect(send.mock.calls).toEqual([["Runtime.runIfWaitingForDebugger", {}, "iframe-session"]]);
  });

  it("routes tab events to the page session once the page is announced", async () => {
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(vi.fn()), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.event("Page.loadEventFired", {}, undefined);
    expect(written).toEqual([]);
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await settle();
    // Electron passes an empty session id for the page's own events.
    relay.event("Page.loadEventFired", { timestamp: 1 }, "");
    relay.event("Runtime.consoleAPICalled", {}, "iframe-session");
    expect(written.slice(-2)).toEqual([
      { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "t3-preview-page" },
      { method: "Runtime.consoleAPICalled", params: {}, sessionId: "iframe-session" },
    ]);
  });
});

describe("CDP relay extra sessions", () => {
  it("gives a second page session the page's commands and events", async () => {
    const send = vi.fn(async () => ({}));
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(makeTarget(send), (raw) =>
      written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.attachToBrowserTarget" }));
    await settle();
    const browserSession = (written.find((m) => m["id"] === 2)!["result"] as { sessionId: string })
      .sessionId;
    relay.receive(
      JSON.stringify({
        id: 3,
        method: "Target.attachToTarget",
        params: { targetId: "GUEST-TARGET", flatten: true },
        sessionId: browserSession,
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 4,
        method: "Target.attachToTarget",
        params: { targetId: "SOMETHING-ELSE" },
        sessionId: browserSession,
      }),
    );
    await settle();
    const extra = (written.find((m) => m["id"] === 3)!["result"] as { sessionId: string })
      .sessionId;
    expect(written.find((m) => m["id"] === 4)).toHaveProperty("error");
    relay.receive(JSON.stringify({ id: 5, method: "Page.startScreencast", sessionId: extra }));
    await settle();
    expect(send).toHaveBeenLastCalledWith("Page.startScreencast", {}, undefined);
    written.length = 0;
    relay.event("Page.screencastFrame", { data: "x" }, undefined);
    expect(written.map((m) => m["sessionId"])).toEqual(["t3-preview-page", extra]);
  });
});

describe("CDP relay downloads", () => {
  it("applies the server's download directory and reports downloads on the root session", async () => {
    const send = vi.fn(async () => ({}));
    const directories: Array<string | null> = [];
    const written: Array<Record<string, unknown>> = [];
    const relay = createCdpRelayConnection(
      makeTarget(send, (directory) => directories.push(directory)),
      (raw) => written.push(JSON.parse(raw)),
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Browser.setDownloadBehavior",
        params: {
          behavior: "allowAndName",
          browserContextId: "t3-preview",
          downloadPath: "/srv/artifacts",
          eventsEnabled: true,
        },
      }),
    );
    await settle();
    expect(directories).toEqual(["/srv/artifacts"]);
    // The tab's own debugger has no such context, so the id stays here.
    expect(send).toHaveBeenCalledWith(
      "Browser.setDownloadBehavior",
      { behavior: "allowAndName", downloadPath: "/srv/artifacts", eventsEnabled: true },
      undefined,
    );
    written.length = 0;
    relay.event("Browser.downloadWillBegin", { guid: "g1", suggestedFilename: "r.csv" }, "");
    expect(written).toEqual([
      { method: "Browser.downloadWillBegin", params: { guid: "g1", suggestedFilename: "r.csv" } },
    ]);
  });
});

describe("per-command completion", () => {
  it("settles fast 201 independently of deferred 200 and waits for the actual sink", async () => {
    const slow = Promise.withResolvers<unknown>();
    const sink = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    const ids: number[] = [];
    const relay = createCdpRelayConnection(
      makeTarget((method) => (method === "Runtime.evaluate" ? slow.promise : Promise.resolve({}))),
      async (raw) => {
        const id = (JSON.parse(raw) as { id: number }).id;
        ids.push(id);
        if (id === 200) {
          accepted.resolve();
          await sink.promise;
        }
      },
    );
    let settled = false;
    const pending = relay.receive(
      JSON.stringify({ id: 200, method: "Runtime.evaluate", sessionId: "t3-preview-page" }),
    )!;
    void pending.then(() => {
      settled = true;
    });
    await relay.receive(
      JSON.stringify({ id: 201, method: "DOM.enable", sessionId: "t3-preview-page" }),
    );
    expect(ids).toEqual([201]);
    slow.resolve({});
    await accepted.promise;
    expect(settled).toBe(false);
    sink.resolve();
    await pending;
    expect(ids).toEqual([201, 200]);
  });

  it("waits for reply acceptance before announcement and for announcement acceptance before settlement", async () => {
    const reply = Promise.withResolvers<void>();
    const announcement = Promise.withResolvers<void>();
    const announcing = Promise.withResolvers<void>();
    const calls: string[] = [];
    const relay = createCdpRelayConnection(
      makeTarget(async () => ({})),
      async (raw) => {
        if ("id" in JSON.parse(raw)) {
          calls.push("reply");
          await reply.promise;
        } else {
          calls.push("announcement");
          announcing.resolve();
          await announcement.promise;
        }
      },
    );
    let settled = false;
    const pending = relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach" }))!;
    void pending.then(() => {
      settled = true;
    });
    reply.resolve();
    await announcing.promise;
    expect(calls).toEqual(["reply", "announcement"]);
    expect(settled).toBe(false);
    announcement.resolve();
    await pending;
    expect(settled).toBe(true);
  });

  it("settles a target error only after its error reply is accepted and propagates sink failure", async () => {
    const accepted = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const relay = createCdpRelayConnection(
      makeTarget(async () => {
        throw new Error("synthetic");
      }),
      async (raw) => {
        expect(JSON.parse(raw)).toMatchObject({ id: 200, error: { code: -32000 } });
        entered.resolve();
        await accepted.promise;
      },
    );
    const pending = relay.receive(
      JSON.stringify({ id: 200, method: "Runtime.evaluate", sessionId: "t3-preview-page" }),
    )!;
    await entered.promise;
    accepted.reject(new Error("sink unavailable"));
    await expect(pending).rejects.toThrow("sink unavailable");
    expect(relay.receive("invalid")).toBeUndefined();
  });
});
