import { describe, expect, it } from "vite-plus/test";

import { chartGeometry } from "./chartGeometry";
import { parseStreamableUi, STREAMABLE_UI_LIMITS } from "./protocol";

const table = {
  type: "table",
  id: "prices",
  title: "NVDA daily close (USD)",
  columns: ["Date", "Close"],
};
const row = { type: "row", id: "prices", cells: ["2026-10-15", 123.45] };
const chart = { type: "chart", id: "trend", title: "NVDA", xLabel: "Date", yLabel: "USD" };
const point = { type: "point", id: "trend", label: "2026-10-15", value: 123.45 };
const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

describe("streamable UI records", () => {
  it("commits rows and chart points before the fence finishes, never a partial price", () => {
    const complete = lines(table, row, chart, point);
    const partial = `${complete}\n{"type":"point","id":"trend","label":"2026-10-16","value":12`;
    const streaming = parseStreamableUi(partial, true);
    expect(streaming.pending).toBe(true);
    expect(streaming.error).toBeUndefined();
    expect(streaming.components).toMatchObject([
      { type: "table", rows: [["2026-10-15", 123.45]] },
      { type: "chart", points: [{ label: "2026-10-15", value: 123.45 }] },
    ]);
    const finished = parseStreamableUi(`${partial}4.56}`, false);
    expect(finished.error).toBeUndefined();
    expect(finished.components[1]).toMatchObject({
      points: [point, { label: "2026-10-16", value: 124.56 }].map(({ label, value }) => ({
        label,
        value,
      })),
    });
    expect(parseStreamableUi(partial, false).error).toContain("line 5");
  });

  it("retains exactly the completed record prefix at every token boundary", () => {
    const records = [table, row, chart, point].map((record) => JSON.stringify(record));
    const document = records.join("\n");
    for (let length = 0; length <= document.length; length++) {
      const result = parseStreamableUi(document.slice(0, length), true);
      expect(result.error).toBeUndefined();
      const completed = records.reduce(
        (state, record) => {
          const end = state.offset + record.length;
          return { offset: end + 1, count: state.count + Number(end <= length) };
        },
        { offset: 0, count: 0 },
      ).count;
      expect(result.components.length).toBe(completed < 3 ? Math.min(completed, 1) : 2);
      const prices = result.components[0];
      if (prices?.type === "table") expect(prices.rows.length).toBe(Number(completed >= 2));
      const trend = result.components[1];
      if (trend?.type === "chart") expect(trend.points.length).toBe(Number(completed === 4));
    }
  });

  it.each([
    { ...table, component: "script" },
    { ...table, style: { color: "red" } },
    { ...table, onClick: "alert(1)" },
    { ...table, __proto__: { type: "chart" }, type: "HtmlView" },
    { ...chart, id: "../escape" },
    { type: "point", id: "absent", label: "x", value: 1 },
    { ...point, value: "123.45" },
    { ...point, value: 1e100 },
    { ...row, cells: [1] },
    { ...table, columns: [] },
    { ...table, title: " " },
    { ...table, columns: [""] },
  ])("rejects executable, unknown or invalid schemas: %j", (record) => {
    const candidate =
      record.type === "table" || record.type === "HtmlView" ? { ...record, id: "invalid" } : record;
    expect(parseStreamableUi(lines(table, chart, candidate), false).error).toBeDefined();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>",
    "file:///tmp/x",
    "https://user:pass@example.com",
    "https://example.com\n/path",
  ])("rejects unsafe citation URLs: %s", (url) => {
    const record = { ...chart, sources: [{ label: "Source", url }] };
    expect(parseStreamableUi(lines(record), false).components).toEqual([]);
    expect(parseStreamableUi(lines(record), false).error).toBeDefined();
  });

  it("preserves explicit source labels and https destinations", () => {
    const sources = [
      { label: "NVIDIA historical data", url: "https://example.com/nvda?day=15#close" },
    ];
    expect(parseStreamableUi(lines({ ...table, sources }), false).components[0]).toMatchObject({
      sources,
    });
  });

  it("enforces size, component and per-table limits", () => {
    expect(
      parseStreamableUi("x".repeat(STREAMABLE_UI_LIMITS.characters + 1), true).error,
    ).toContain("size limit");
    const rows = Array.from({ length: STREAMABLE_UI_LIMITS.items + 1 }, () => row);
    const result = parseStreamableUi(lines(table, ...rows), false);
    expect(result.error).toBeDefined();
    expect(result.components[0]).toMatchObject({
      rows: Array.from({ length: STREAMABLE_UI_LIMITS.items }, () => row.cells),
    });
    const charts = Array.from({ length: STREAMABLE_UI_LIMITS.components + 1 }, (_, i) => ({
      ...chart,
      id: `chart${i}`,
    }));
    expect(parseStreamableUi(lines(...charts), false).components).toHaveLength(
      STREAMABLE_UI_LIMITS.components,
    );
    const blankLines = "\n".repeat(1_000);
    expect(parseStreamableUi(blankLines + lines(table), false).error).toBeUndefined();
  });

  it("bounds the total number of records across multiple components", () => {
    const records = Array.from({ length: 3 }, (_, i) => [
      { ...table, id: `table${i}` },
      ...Array.from({ length: 200 }, () => ({ ...row, id: `table${i}` })),
    ]).flat();
    expect(parseStreamableUi(lines(...records), false).error).toContain("record limit");
  });

  it("reports a stopped empty visual rather than leaving a loading indicator", () => {
    expect(parseStreamableUi("", true)).toMatchObject({ pending: true, error: undefined });
    expect(parseStreamableUi("", false)).toMatchObject({
      pending: false,
      error: "Visual has no components.",
    });
  });

  it("rejects duplicate declarations without discarding previously completed data", () => {
    const result = parseStreamableUi(lines(table, row, table), false);
    expect(result.error).toContain("line 3");
    expect(result.components).toMatchObject([{ type: "table", rows: [row.cells] }]);
  });
});

describe("chart geometry", () => {
  it.each([[0], [0, 0], [-10, 0, 10], [1e12, -1e12]])(
    "keeps flat, single and negative series within the plot: %j",
    (...values) => {
      const geometry = chartGeometry(values.map((value) => ({ label: "x", value })))!;
      for (const point of geometry.coordinates) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(52);
        expect(point.x).toBeLessThanOrEqual(548);
        expect(point.y).toBeGreaterThanOrEqual(36);
        expect(point.y).toBeLessThanOrEqual(164);
      }
    },
  );
  it("handles an empty series", () => {
    expect(chartGeometry([])).toBeUndefined();
  });
});
