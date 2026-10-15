import type * as Electron from "electron";
import type { AutofillTarget } from "./ProtonPassAutofill.ts";
import { makeAutofill } from "./ProtonPassAutofill.ts";
import { ProtonPassUnavailable } from "./ProtonPassCli.ts";

export interface AutofillMenuUi {
  choose(title: string, choices: readonly string[]): Promise<number | undefined>;
  notice(message: string): Promise<void>;
  restoreFocus(): void;
}
const label = (value: string) =>
  value
    .replace(/[\r\n\t]/g, " ")
    .replaceAll("&", "&&")
    .slice(0, 120);
/** Native menus expose references and static statuses only, never credential values. */
export async function makeAutofillMenu(
  target: AutofillTarget,
  service: ReturnType<typeof makeAutofill>,
  ui: AutofillMenuUi,
): Promise<Electron.MenuItemConstructorOptions[]> {
  const action = (operation: () => Promise<void>) => () => {
    ui.restoreFocus();
    return operation().catch(async (error: unknown) => {
      try {
        await ui.notice(
          error instanceof ProtonPassUnavailable
            ? error.message
            : "Proton Pass could not complete this private fill. The tab remains private; clear fields and resume sharing explicitly.",
        );
      } catch {
        /* Keep the tab private if native UI is unavailable. */
      }
    });
  };
  const linked = await service.linked(target).catch(() => []);
  return [
    {
      label: "Proton Pass",
      submenu: [
        ...(target.privateEntry
          ? [{ label: "Private entry — sharing paused", enabled: false }]
          : []),
        { label: `Linked logins for ${label(target.origin)}`, enabled: false },
        ...linked.flatMap((entry) => [
          {
            label: `Fill ${label(entry.title)}`,
            click: action(() => service.fill(target, entry)),
          },
          {
            label: `Remove linked login: ${label(entry.title)}`,
            click: action(() => service.unlink(target, entry)),
          },
        ]),
        {
          label: "Link a login to this site…",
          click: action(async () => {
            const selected = await service.link(target, async (provider) => {
              const vaults = await provider.vaults();
              const vaultIndex = await ui.choose(
                "Choose a Proton vault",
                vaults.map((entry) => entry.title),
              );
              const vault = vaultIndex === undefined ? undefined : vaults[vaultIndex];
              if (!vault) return;
              const items = await provider.logins(vault.shareId);
              const itemIndex = await ui.choose(
                `Link a login to ${target.origin}`,
                items.map((entry) => entry.title),
              );
              ui.restoreFocus();
              return itemIndex === undefined ? undefined : items[itemIndex];
            });
            if (selected) await service.fill(target, selected);
          }),
        },
        ...(target.privateEntry
          ? [
              {
                label: "Clear login fields and resume sharing",
                click: action(() => service.clearAndResume(target)),
              },
            ]
          : []),
      ],
    },
  ];
}
