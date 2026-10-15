import { defineConfig } from "vite-plus";
import * as Path from "node:path";
import { isDesktopRuntimeExternalDependency } from "../../../../scripts/lib/desktop-external-packages.ts";

const outDir = process.env.MORROWBYTE_CORE_UPDATE_ADMISSION_BUNDLE_DIR;
if (!outDir || !Path.isAbsolute(outDir))
  throw new Error("Absolute core fixture bundle directory required");
const external = (id: string) =>
  id === "electron" || id.startsWith("electron/") || isDesktopRuntimeExternalDependency(id);
export default defineConfig({
  pack: [
    {
      entry: ["main.ts"],
      format: "cjs",
      outDir,
      clean: true,
      dts: false,
      sourcemap: false,
      outExtensions: () => ({ js: ".cjs" }),
      outputOptions: { codeSplitting: false },
      define: { __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify("") },
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !external(id),
        neverBundle: external,
        onlyBundle: false,
      },
    },
  ],
});
