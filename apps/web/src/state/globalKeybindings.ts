import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { mergeWithDefaultKeybindings } from "@t3tools/shared/keybindings";
import { Atom } from "effect/reactivity";

type KeybindingsConfig = Pick<ServerConfig, "keybindings">;

export function createGlobalKeybindingsAtom(input: {
  readonly primaryServerConfigAtom: Atom.Atom<KeybindingsConfig | null>;
  readonly environmentServerConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, KeybindingsConfig>>;
}) {
  return Atom.make((get): ServerConfig["keybindings"] => {
    // A desktop with its local environment disabled has no primary target.
    // Use the first enabled environment with config, as Settings does.
    const config =
      get(input.primaryServerConfigAtom) ??
      get(input.environmentServerConfigsAtom).values().next().value;
    return mergeWithDefaultKeybindings(config?.keybindings ?? []);
  }).pipe(Atom.withLabel("web-primary-server-keybindings"));
}
