import { EnvironmentId } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createGlobalKeybindingsAtom } from "./globalKeybindings";

type Config = { keybindings: ReturnType<typeof compileResolvedKeybindingsConfig> };
const nixy = EnvironmentId.make("nixy");
const remote = EnvironmentId.make("remote");
const config = (key: string): Config => ({
  keybindings: compileResolvedKeybindingsConfig([{ key, command: "thread.next" }]),
});

function setup(primary: Config | null, environments: ReadonlyMap<EnvironmentId, Config>) {
  const primaryServerConfigAtom = Atom.make<Config | null>(primary);
  const environmentServerConfigsAtom = Atom.make(environments);
  const bindings = createGlobalKeybindingsAtom({
    primaryServerConfigAtom,
    environmentServerConfigsAtom,
  });
  const registry = AtomRegistry.make();
  registry.mount(bindings);
  const next = () => registry.get(bindings).filter((rule) => rule.command === "thread.next");
  return { registry, environmentServerConfigsAtom, next };
}

describe("global keybindings", () => {
  it("uses a connected server's custom shortcuts when the local environment is off", () => {
    const state = setup(null, new Map([[nixy, config("ctrl+l")]]));
    expect(state.next().map((rule) => rule.shortcut.key)).toEqual(["l"]);
    state.registry.dispose();
  });

  it("retains primary environment precedence", () => {
    const state = setup(config("ctrl+h"), new Map([[remote, config("ctrl+l")]]));
    expect(state.next().map((rule) => rule.shortcut.key)).toEqual(["h"]);
    state.registry.dispose();
  });

  it("replaces defaults as remote config arrives and follows subsequent edits", () => {
    const state = setup(null, new Map());
    expect(state.next().map((rule) => rule.shortcut.key)).toEqual(["]"]);
    state.registry.set(state.environmentServerConfigsAtom, new Map([[nixy, config("ctrl+l")]]));
    expect(state.next().map((rule) => rule.shortcut.key)).toEqual(["l"]);
    state.registry.set(state.environmentServerConfigsAtom, new Map([[nixy, config("ctrl+j")]]));
    expect(state.next().map((rule) => rule.shortcut.key)).toEqual(["j"]);
    state.registry.dispose();
  });
});
