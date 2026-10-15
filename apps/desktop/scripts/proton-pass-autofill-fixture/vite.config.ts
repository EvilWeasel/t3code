import * as NodePath from "node:path";
import { defineConfig } from "vite-plus";
import { isDesktopRuntimeExternalDependency } from "../../../../scripts/lib/desktop-external-packages.ts";

const output = process.env.MORROWBYTE_AUTOFILL_BUNDLE_DIR;
const temporary = process.env.RUNNER_TEMP;
if (
  !output ||
  !temporary ||
  !NodePath.isAbsolute(output) ||
  !NodePath.resolve(output).startsWith(`${NodePath.resolve(temporary)}${NodePath.sep}`)
)
  throw new Error("Provide an owned RUNNER_TEMP/MORROWBYTE_AUTOFILL_BUNDLE_DIR");
const external = (id: string) =>
  id === "electron" || id.startsWith("node:") || isDesktopRuntimeExternalDependency(id);
export default defineConfig({
  pack: [
    {
      entry: ["main.ts"],
      format: "cjs",
      outDir: output,
      dts: false,
      sourcemap: false,
      clean: true,
      outExtensions: () => ({ js: ".cjs" }),
      outputOptions: { codeSplitting: false },
      define: { __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify("") },
      deps: { alwaysBundle: (id) => !external(id), neverBundle: external, onlyBundle: false },
    },
  ],
});
