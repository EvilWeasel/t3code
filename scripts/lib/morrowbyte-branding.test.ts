import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));

describe("Morrowbyte installed branding", () => {
  it("has an installable named manifest whose declared PNG dimensions match the existing artwork", () => {
    const manifest = JSON.parse(read("apps/web/public/manifest.webmanifest").toString());
    expect(manifest.name).toBe("Morrowbyte");
    expect(manifest.short_name).toBe("Morrowbyte");
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    const png = manifest.icons.find((icon: { type: string }) => icon.type === "image/png");
    expect(png).toBeDefined();
    const bytes = read(`apps/web/public${png.src}`);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(png.sizes).toBe(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`);
    expect(bytes.readUInt32BE(16)).toBeGreaterThanOrEqual(512);
    expect(bytes).toEqual(read("assets/weasel/fork-1024.png"));
    expect(manifest.icons).toContainEqual({
      src: "/morrowbyte-icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    });
  });

  it("uses the bundled icon and Morrowbyte label for the Nix desktop entry", () => {
    const flake = read("packaging/nixos/flake.nix").toString();
    expect(flake).toContain("Name=Morrowbyte");
    expect(flake).toContain("Icon=t3code");
    expect(flake).toContain("Exec=t3code-weasel %U");
    for (const installer of ["packaging/nixos/install.sh", "scripts/weasel/install-linux.sh"]) {
      expect(read(installer).toString()).toContain("Name=Morrowbyte");
    }
  });

  it("uses the same existing artwork for browser, Apple install and loading surfaces", () => {
    expect(read("apps/web/public/morrowbyte-icon.svg")).toEqual(read("assets/weasel/fork.svg"));
    expect(read("apps/web/public/morrowbyte-icon.ico")).toEqual(read("assets/weasel/fork.ico"));
    const html = read("apps/web/index.html").toString();
    expect(html).toContain('<link rel="apple-touch-icon" href="/morrowbyte-icon.png"');
    expect(html).toContain('<link rel="icon" href="/morrowbyte-icon.ico"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Morrowbyte"');
    expect(html).toContain("<title>Morrowbyte</title>");
    expect(html).toContain('src="/morrowbyte-icon.png" alt="Morrowbyte"');
  });
});
