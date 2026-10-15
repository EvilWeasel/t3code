import { expect, it, vi } from "vite-plus/test";
import { makeProtonPassProvider, ProtonPassUnavailable } from "./ProtonPassCli.ts";

it("lists metadata only and resolves just the explicitly selected item's two fields", async () => {
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === "--version") return "Proton Pass CLI 2.4.2 (fixture)\n";
    if (args[0] === "vault")
      return JSON.stringify({ vaults: [{ share_id: "v", name: "Personal" }] });
    if (args[1] === "list")
      return JSON.stringify({
        items: [
          {
            id: "i",
            share_id: "v",
            title: "Site",
            item_type: "login",
            password: "never-project-this",
          },
          { id: "other", share_id: "other-vault", title: "Other", item_type: "login" },
        ],
      });
    return args.at(-1) === "username" ? "fake-user\n" : "fake-password\n\n";
  });
  const provider = makeProtonPassProvider(run);
  expect(await provider.vaults()).toEqual([{ shareId: "v", title: "Personal" }]);
  const [selected] = await provider.logins("v");
  expect(selected).toEqual({ shareId: "v", itemId: "i", title: "Site" });
  expect(run.mock.calls.some(([args]) => args[1] === "view")).toBe(false);
  expect(await provider.credentials(selected!)).toEqual({
    username: "fake-user",
    password: "fake-password\n",
  });
  expect(run.mock.calls.filter(([args]) => args[1] === "view").map(([args]) => args)).toEqual([
    ["item", "view", "--share-id", "v", "--item-id", "i", "--field", "username"],
    ["item", "view", "--share-id", "v", "--item-id", "i", "--field", "password"],
  ]);
  expect(run.mock.calls.flatMap(([args]) => args)).not.toContain("--show-secrets");
});
it("refuses an unqualified CLI version before any metadata or secret request", async () => {
  const run = vi.fn(async () => "Proton Pass CLI 1.0.0\n");
  await expect(makeProtonPassProvider(run).vaults()).rejects.toMatchObject({
    state: "unsupported",
  });
  expect(run).toHaveBeenCalledOnce();
});
it("rejects unexpected metadata without echoing the private response", async () => {
  const run = vi.fn(async (args: readonly string[]) =>
    args[0] === "--version" ? "Proton Pass CLI 2.4.2" : "private-upstream-data",
  );
  await expect(makeProtonPassProvider(run).vaults()).rejects.toBeInstanceOf(ProtonPassUnavailable);
  await expect(makeProtonPassProvider(run).vaults()).rejects.not.toThrow("private-upstream-data");
});
