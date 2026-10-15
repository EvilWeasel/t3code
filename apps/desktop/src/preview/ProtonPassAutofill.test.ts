import { expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  makeAutofill,
  makeBindingStore,
  type LinkedLogin,
  type AutofillTarget,
} from "./ProtonPassAutofill.ts";

const login = { shareId: "vault", itemId: "item", title: "Fake login" };
const fixture = () => {
  const order: string[] = [];
  let entries: readonly LinkedLogin[] = [
    { ...login, origin: "https://site.test", partition: "persist:profile-a" },
  ];
  const target: AutofillTarget = {
    origin: "https://site.test",
    partition: "persist:profile-a",
    privateEntry: false,
    current: () => true,
    enterPrivate: vi.fn(async () => {
      order.push("private");
    }),
    fill: vi.fn(async () => {
      order.push("fill");
    }),
    clearAndResume: vi.fn(async () => {}),
  };
  const provider = {
    vaults: vi.fn(async () => []),
    logins: vi.fn(async () => []),
    credentials: vi.fn(async () => {
      order.push("secret");
      return { username: "fake-user", password: "fake-password" };
    }),
  };
  const service = makeAutofill(provider, {
    read: async () => entries,
    write: async (value) => {
      entries = value;
    },
  });
  return { order, target, provider, service };
};
it("fills only a linked login after the private gate and leaves sharing private", async () => {
  const { order, target, provider, service } = fixture();
  expect(await service.linked(target)).toEqual([
    { ...login, origin: target.origin, partition: target.partition },
  ]);
  expect(provider.credentials).not.toHaveBeenCalled();
  await service.fill(target, login);
  expect(order).toEqual(["private", "secret", "fill"]);
  expect(target.fill).toHaveBeenCalledWith("fake-user", "fake-password");
  expect(target.clearAndResume).not.toHaveBeenCalled();
});
it("never resolves a secret if privacy admission is refused by an in-flight capture", async () => {
  const { target, provider, service } = fixture();
  target.enterPrivate = vi.fn(async () => {
    throw new Error("Capture in flight");
  });
  await expect(service.fill(target, login)).rejects.toThrow();
  expect(provider.credentials).not.toHaveBeenCalled();
  expect(target.fill).not.toHaveBeenCalled();
});
it.each([
  { origin: "https://other.test" },
  { partition: "persist:profile-b" },
  { partition: "ephemeral" },
])("rejects a mismatched target %j before secret retrieval", async (change) => {
  const { target, provider, service } = fixture();
  const changedTarget: AutofillTarget = { ...target, ...change };
  await expect(service.fill(changedTarget, login)).rejects.toThrow();
  expect(provider.credentials).not.toHaveBeenCalled();
});
it("does not deliver a credential after navigation while the selected read was pending", async () => {
  const { target, provider, service } = fixture();
  let current = true;
  target.current = () => current;
  provider.credentials.mockImplementationOnce(async () => {
    current = false;
    return { username: "fake-user", password: "fake-password" };
  });
  await expect(service.fill(target, login)).rejects.toThrow();
  expect(target.fill).not.toHaveBeenCalled();
  expect(target.clearAndResume).not.toHaveBeenCalled();
});
it("cancelling the native item choice reads no credentials and keeps privacy enabled", async () => {
  const { target, provider, service } = fixture();
  await service.link(target, async () => undefined);
  expect(provider.credentials).not.toHaveBeenCalled();
  expect(target.clearAndResume).not.toHaveBeenCalled();
});
it("persists only reference fields even if an input object contains extra secret properties", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "proton-bindings-test-"));
  try {
    const file = NodePath.join(directory, "bindings.json");
    const store = makeBindingStore(file);
    const entry = {
      ...login,
      origin: "https://site.test",
      partition: "persist:p",
      password: "must-not-persist",
    };
    await store.write([entry]);
    expect(await NodeFSP.readFile(file, "utf8")).not.toContain("must-not-persist");
    expect(await store.read()).toEqual([
      { ...login, origin: "https://site.test", partition: "persist:p" },
    ]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
