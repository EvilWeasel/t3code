import { describe, expect, it } from "vitest";

import { HtmlPreviewTool, HtmlRenderToolkit } from "./tools.ts";

describe("interactive HTML tool guidance", () => {
  it("supports durable, editable diagrams through the isolated HTML artifact surface", () => {
    const description = [
      HtmlPreviewTool.description,
      HtmlRenderToolkit.tools.html_render.description,
    ]
      .join(" ")
      .toLowerCase();

    expect(description).toContain("interactive diagrams");
    expect(description).toContain("follow-up edit");
    expect(description).toContain("durable thread artifact");
    expect(description).toContain("archify-compatible workflows");
    expect(description).toContain("screenshot");
    expect(description).toContain("theme variables");
  });
});
