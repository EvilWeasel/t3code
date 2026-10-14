import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { bootstrapMissingFleetPeers } from "./fleetBootstrap";

const primary = EnvironmentId.make("heph");
const peer = (id: string, httpBaseUrl = `https://${id}.example.test/`) => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  httpBaseUrl,
});

describe("paired browser fleet", () => {
  it("adds missing peers once, preserving primary and every saved user choice", async () => {
    const connect = vi.fn(async (_value: ReturnType<typeof peer>) => {});
    const existing = new Set(["disabled", "saved"]);
    const nixy = peer("nixy");
    const result = await bootstrapMissingFleetPeers({
      primaryEnvironmentId: primary,
      peers: [peer("heph"), peer("disabled"), peer("saved"), nixy, nixy, peer("blain")],
      hasSavedEnvironment: (id) => existing.has(id),
      connect,
    });
    expect(result).toEqual([]);
    expect(connect.mock.calls.map(([value]) => value.environmentId)).toEqual(["nixy", "blain"]);
  });

  it("rechecks saved entries before pairing so another client operation wins", async () => {
    const hasSavedEnvironment = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const connect = vi.fn(async (_value: ReturnType<typeof peer>) => {});
    await bootstrapMissingFleetPeers({
      primaryEnvironmentId: primary,
      peers: [peer("nixy"), peer("blain")],
      hasSavedEnvironment,
      connect,
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("continues after a failed host without returning sensitive provider errors", async () => {
    const connect = vi.fn(async (value: ReturnType<typeof peer>) => {
      if (value.label === "nixy") throw new Error("private-pairing-credential");
    });
    const result = await bootstrapMissingFleetPeers({
      primaryEnvironmentId: primary,
      peers: [peer("nixy"), peer("blain")],
      hasSavedEnvironment: () => false,
      connect,
    });
    expect(result).toEqual(["nixy"]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  it.each([
    "http://nixy.example.test/",
    "https://user:secret@nixy.example.test/",
    "https://nixy.example.test/peers",
    "https://nixy.example.test/?token=secret",
  ])("does not request a grant for an unsafe browser route %s", async (url) => {
    const connect = vi.fn(async (_value: ReturnType<typeof peer>) => {});
    const result = await bootstrapMissingFleetPeers({
      primaryEnvironmentId: primary,
      peers: [peer("nixy", url)],
      hasSavedEnvironment: () => false,
      connect,
    });
    expect(result).toEqual(["nixy"]);
    expect(connect).not.toHaveBeenCalled();
  });
});
