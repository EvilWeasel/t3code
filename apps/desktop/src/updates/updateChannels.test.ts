import { describe, expect, it } from "vite-plus/test";

import {
  isNightlyDesktopVersion,
  isReleasedDesktopVersionForChannel,
  resolveDefaultDesktopUpdateChannel,
} from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });

  it("admits only released versions from the selected train", () => {
    expect(isReleasedDesktopVersionForChannel("1.2.3", "latest")).toBe(true);
    expect(isReleasedDesktopVersionForChannel("1.2.3-nightly.20261015.1", "nightly")).toBe(true);
    for (const version of [
      "1.2.3-preview.20261015.1",
      "1.2.3-pr.42",
      "1.2.3-beta.1",
      "not-a-version",
      "1.2.3+test",
      "01.2.3",
    ]) {
      expect(isReleasedDesktopVersionForChannel(version, "latest")).toBe(false);
      expect(isReleasedDesktopVersionForChannel(version, "nightly")).toBe(false);
    }
    expect(isReleasedDesktopVersionForChannel("1.2.3", "nightly")).toBe(false);
    expect(isReleasedDesktopVersionForChannel("1.2.3-nightly.20261015.1", "latest")).toBe(false);
  });
});
