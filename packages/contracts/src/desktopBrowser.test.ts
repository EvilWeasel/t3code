import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DesktopBrowserEvent,
  DesktopBrowserCommand,
  DesktopBrowserPrivateEntryRequest,
  DesktopBrowserPrivateEntryResponse,
} from "./desktopBrowser.ts";

const target = {
  threadId: "thread-a",
  tabId: "tab-a",
  channelEpoch: "channel-a",
  attachmentId: "attachment-a",
  requestId: "request-a",
};
const lease = { ...target, leaseId: "lease-a", generation: 2 };
describe("desktop native private-entry boundary", () => {
  it("round-trips bound acquire, cancel, release and all result variants", () => {
    for (const request of [
      { type: "private-entry-acquire", ...target },
      { type: "private-entry-cancel", ...target },
      { type: "private-entry-release", ...lease },
    ])
      expect(Schema.decodeUnknownSync(DesktopBrowserEvent)(request)).toEqual(request);
    for (const response of [
      { type: "private-entry-granted", ...lease },
      { type: "private-entry-released", ...lease },
      { type: "private-entry-revoked", ...lease, reason: "closed" },
      { type: "private-entry-refused", ...target, reason: "agent-owned" },
    ])
      expect(Schema.decodeUnknownSync(DesktopBrowserCommand)(response)).toEqual(response);
  });
  it("does not turn legacy attach into ownership permission", () => {
    const legacy = Schema.decodeUnknownSync(DesktopBrowserEvent)({
      type: "attached",
      threadId: "thread-a",
      tabId: "tab-a",
    });
    expect("privateEntry" in legacy).toBe(false);
    expect(
      Schema.decodeUnknownSync(DesktopBrowserEvent)({
        type: "attached",
        threadId: "thread-a",
        tabId: "tab-a",
        privateEntry: { channelEpoch: "c", attachmentId: "a" },
      }),
    ).toMatchObject({ privateEntry: { channelEpoch: "c", attachmentId: "a" } });
  });
  it("rejects missing binding, invalid generations and secret or authority extensions", () => {
    const decodeRequest = Schema.decodeUnknownSync(DesktopBrowserPrivateEntryRequest);
    const decodeResponse = Schema.decodeUnknownSync(DesktopBrowserPrivateEntryResponse);
    for (const field of ["requestId", "channelEpoch", "attachmentId"] as const) {
      const { [field]: _missing, ...partial } = target;
      expect(() => decodeRequest({ type: "private-entry-acquire", ...partial })).toThrow();
    }
    for (const generation of [-1, 1.5, Infinity, NaN])
      expect(() =>
        decodeResponse({ type: "private-entry-granted", ...lease, generation }),
      ).toThrow();
    for (const field of ["username", "password", "token", "owner", "provider", "credentials"]) {
      expect(() =>
        decodeRequest({ type: "private-entry-acquire", ...target, [field]: "forbidden" }),
      ).toThrow();
      expect(() =>
        decodeResponse({ type: "private-entry-granted", ...lease, [field]: "forbidden" }),
      ).toThrow();
    }
  });
});
