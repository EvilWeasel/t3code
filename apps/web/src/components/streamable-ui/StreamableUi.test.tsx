// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { StreamableUi } from "./StreamableUi";

describe("native streamable visuals", () => {
  it("appends real table rows and chart points while keeping data disclosure and sources available", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const header = [
      {
        type: "metric",
        id: "close",
        label: "NVDA close",
        value: "$123.45",
        detail: "Illustrative test data",
      },
      {
        type: "table",
        id: "prices",
        title: "Daily comparison",
        columns: ["Date", "USD"],
        sources: [{ label: "Price source", url: "https://example.com/nvda" }],
      },
      { type: "row", id: "prices", cells: ["Day 1", 123.45] },
      { type: "chart", id: "trend", title: "Daily close", xLabel: "Date", yLabel: "USD" },
      { type: "point", id: "trend", label: "Day 1", value: 123.45 },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const unfinished = '\n{"type":"row","id":"prices","cells":["Day 2",12';
    try {
      await act(async () => root.render(<StreamableUi code={header + unfinished} isStreaming />));
      const table = container.querySelector("table")!;
      const firstRow = table.querySelector("tbody tr");
      expect(table.querySelectorAll("tbody tr")).toHaveLength(1);
      expect(container.querySelectorAll("svg circle")).toHaveLength(1);
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Receiving");
      expect(container.querySelector("a")?.href).toBe("https://example.com/nvda");
      const disclosure = container.querySelector("details")!;
      disclosure.querySelector("summary")!.click();
      expect(disclosure.open).toBe(true);
      expect(disclosure.querySelector("table")?.textContent).toContain("123.45");

      const finished =
        header +
        unfinished +
        '4.56]}\n{"type":"point","id":"trend","label":"Day 2","value":124.56}';
      await act(async () => root.render(<StreamableUi code={finished} isStreaming={false} />));
      expect(container.querySelector("table")).toBe(table);
      expect(table.querySelector("tbody tr")).toBe(firstRow);
      expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(table.textContent).toContain("124.56");
      expect(container.querySelectorAll("svg circle")).toHaveLength(2);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector("details")).toBe(disclosure);
      expect(disclosure.open).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("escapes executable-looking text and retains readable source for rejected records", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const label = '<img src=x onerror="alert(1)">';
    const code = `${JSON.stringify({ type: "metric", id: "safe", label, value: "<script>alert(1)</script>" })}\n{"type":"html","id":"unsafe","html":"<script>alert(1)</script>"}`;
    try {
      await act(async () => root.render(<StreamableUi code={code} isStreaming={false} />));
      expect(container.querySelector("dt")?.textContent).toBe(label);
      expect(container.querySelector("script, img, iframe")).toBeNull();
      expect(container.querySelector("pre")?.textContent).toBe(code);
      expect(container.querySelector("summary")?.textContent).toContain("line 2");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
