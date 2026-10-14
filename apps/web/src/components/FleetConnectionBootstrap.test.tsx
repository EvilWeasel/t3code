import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  primary: "",
  allowed: true,
  desktop: false,
  catalog: { isReady: true, entries: new Map() },
  read: vi.fn(),
  grant: vi.fn(),
  connect: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.catalog }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: {} } }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => state.catalog } }));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => state.primary }));
vi.mock("../state/session", () => ({ useEnvironmentScope: () => state.allowed }));
vi.mock("../connection/fleetClient", () => ({
  readFleetConnections: state.read,
  createFleetPairing: state.grant,
}));
vi.mock("../connection/onboarding", () => ({ connectPairing: { run: state.connect } }));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast } }));
import { FleetConnectionBootstrap } from "./FleetConnectionBootstrap";

let renderer: ReactTestRenderer | undefined;
let sequence = 0;
const storage = new Map<string, string>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  storage.clear();
  state.primary = `primary-${++sequence}`;
  state.allowed = true;
  state.catalog = { isReady: true, entries: new Map() };
  for (const fn of [state.read, state.grant, state.connect, state.toast]) fn.mockReset();
  state.read.mockResolvedValue({
    connections: [
      { environmentId: "nixy", label: "Nixy", httpBaseUrl: "https://nixy.example.test/" },
    ],
  });
  state.grant.mockResolvedValue({
    environmentId: "nixy",
    httpBaseUrl: "https://nixy.example.test/",
    credential: "one-time-private-code",
  });
  state.connect.mockResolvedValue({ _tag: "Success" });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const mount = async () => {
  await act(async () => {
    renderer = create(
      <StrictMode>
        <FleetConnectionBootstrap />
      </StrictMode>,
    );
  });
};

it("pairs once across strict remounts using a pinned environment and stores no credential in metadata", async () => {
  await mount();
  expect(state.read).toHaveBeenCalledTimes(1);
  expect(state.grant).toHaveBeenCalledTimes(1);
  expect(state.connect).toHaveBeenCalledWith(expect.anything(), {
    host: "https://nixy.example.test/",
    pairingCode: "one-time-private-code",
    expectedEnvironmentId: "nixy",
  });
  expect([...storage.values()]).toEqual(['["nixy"]']);
});

it.each(["permission", "desktop", "not-ready"])("does no discovery for %s", async (reason) => {
  if (reason === "permission") state.allowed = false;
  if (reason === "desktop") vi.stubGlobal("window", { desktopBridge: {} });
  if (reason === "not-ready") state.catalog.isReady = false;
  await mount();
  expect(state.read).not.toHaveBeenCalled();
});

it("preserves a disabled saved connection and remembers an explicit removal", async () => {
  state.catalog.entries.set("nixy", { enabled: false });
  await mount();
  expect(state.grant).not.toHaveBeenCalled();
  expect([...storage.values()]).toEqual(['["nixy"]']);
});

it("does not recreate a previously acknowledged connection removed by the user", async () => {
  storage.set(`morrowbyte:fleet-onboarded:${state.primary}`, '["nixy"]');
  await mount();
  expect(state.grant).not.toHaveBeenCalled();
});

it("rejects a changed grant target without redeeming its code", async () => {
  state.grant.mockResolvedValue({
    environmentId: "different-host",
    httpBaseUrl: "https://different.example.test/",
    credential: "do-not-display",
  });
  await mount();
  expect(state.connect).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith({ type: "error", title: "Could not connect: Nixy" });
  expect(JSON.stringify(state.toast.mock.calls)).not.toContain("do-not-display");
});

it("lets a saved disabled connection created during the grant request win", async () => {
  state.grant.mockImplementation(async () => {
    state.catalog.entries.set("nixy", { enabled: false });
    return { environmentId: "nixy", httpBaseUrl: "https://nixy.example.test/", credential: "unused" };
  });
  await mount();
  expect(state.connect).not.toHaveBeenCalled();
  expect(state.toast).not.toHaveBeenCalled();
});
