import { expect, it, vi } from "vite-plus/test";
import { makeAutofillMenu } from "./ProtonPassAutofillMenu.ts";
import { makeAutofill, type AutofillTarget, type LinkedLogin } from "./ProtonPassAutofill.ts";
import { ProtonPassUnavailable } from "./ProtonPassCli.ts";

const setup = (initialEntries: readonly LinkedLogin[] = []) => {
  const order: string[] = [];
  let entries = initialEntries;
  const provider = {
    vaults: vi.fn(async () => [{ shareId: "v", title: "Personal" }]),
    logins: vi.fn(async () => [{ shareId: "v", itemId: "i", title: "Site" }]),
    credentials: vi.fn(async () => {
      order.push("read");
      return { username: "fake-user", password: "fake-password" };
    }),
  };
  const target: AutofillTarget = {
    origin: "https://site.test",
    partition: "persist:p",
    privateEntry: true,
    current: () => true,
    holdPrivate: () => () => {},
    enterPrivate: async () => {
      order.push("private");
    },
    fill: async () => {
      order.push("fill");
    },
    clearAndResume: vi.fn(async () => {}),
  };
  const service = makeAutofill(provider, {
    read: async () => entries,
    write: async (value) => {
      entries = value;
    },
  });
  const ui = {
    choose: vi.fn(async () => 0 as number | undefined),
    notice: vi.fn(async (_message: string) => {}),
    restoreFocus: vi.fn(),
  };
  return { order, provider, target, service, ui };
};
it("a real menu selection links the chosen item then fills privately without any read on menu opening", async () => {
  const { target, service, ui, provider, order } = setup();
  const menu = await makeAutofillMenu(target, service, ui);
  expect(provider.vaults).not.toHaveBeenCalled();
  expect(provider.credentials).not.toHaveBeenCalled();
  const submenu = menu[0]!.submenu;
  if (!Array.isArray(submenu)) throw new Error("Missing submenu");
  const link = submenu.find((item) => item.label === "Link a login to this site…");
  await (link!.click as () => Promise<void>)();
  expect(ui.choose).toHaveBeenCalledTimes(2);
  expect(provider.credentials).toHaveBeenCalledWith({ shareId: "v", itemId: "i", title: "Site" });
  expect(order).toEqual(["private", "private", "read", "fill"]);
  expect(target.clearAndResume).not.toHaveBeenCalled();
});
it("shows a static locked state and does not read a password or resume after failure", async () => {
  const { target, service, ui, provider } = setup();
  provider.vaults.mockRejectedValueOnce(new ProtonPassUnavailable("locked"));
  const menu = await makeAutofillMenu(target, service, ui);
  const submenu = menu[0]!.submenu;
  if (!Array.isArray(submenu)) throw new Error("Missing submenu");
  await (
    submenu.find((item) => item.label === "Link a login to this site…")!
      .click as () => Promise<void>
  )();
  expect(ui.notice.mock.calls[0]?.[0]).toContain("locked");
  expect(provider.credentials).not.toHaveBeenCalled();
  expect(target.clearAndResume).not.toHaveBeenCalled();
});
it("keeps explicit clear/resume reachable even if the reference store is unreadable", async () => {
  const { target, provider, ui } = setup();
  const service = makeAutofill(provider, {
    read: async () => {
      throw new Error("private corrupt metadata");
    },
    write: async () => {},
  });
  const menu = await makeAutofillMenu(target, service, ui);
  const submenu = menu[0]!.submenu;
  if (!Array.isArray(submenu)) throw new Error("Missing submenu");
  await (
    submenu.find((item) => item.label === "Clear login fields and resume sharing")!
      .click as () => Promise<void>
  )();
  expect(target.clearAndResume).toHaveBeenCalledOnce();
  expect(provider.credentials).not.toHaveBeenCalled();
});

it("removing a saved login updates the next native menu without reading secrets or resuming sharing", async () => {
  const { target, service, provider, ui } = setup([
    {
      origin: "https://site.test",
      partition: "persist:p",
      shareId: "v",
      itemId: "i",
      title: "Site",
    },
  ]);
  const menu = await makeAutofillMenu(target, service, ui);
  const submenu = menu[0]!.submenu;
  if (!Array.isArray(submenu)) throw new Error("Missing submenu");
  await (
    submenu.find((item) => item.label === "Remove linked login: Site")!.click as () => Promise<void>
  )();
  const nextMenu = await makeAutofillMenu(target, service, ui);
  const nextSubmenu = nextMenu[0]!.submenu;
  if (!Array.isArray(nextSubmenu)) throw new Error("Missing submenu");
  expect(nextSubmenu.some((item) => item.label === "Fill Site")).toBe(false);
  expect(nextSubmenu.some((item) => item.label === "Remove linked login: Site")).toBe(false);
  expect(nextSubmenu.some((item) => item.label === "Clear login fields and resume sharing")).toBe(
    true,
  );
  expect(provider.credentials).not.toHaveBeenCalled();
  expect(provider.vaults).not.toHaveBeenCalled();
  expect(provider.logins).not.toHaveBeenCalled();
  expect(target.clearAndResume).not.toHaveBeenCalled();
});
