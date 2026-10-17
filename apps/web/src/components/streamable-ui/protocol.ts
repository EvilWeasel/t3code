export interface VisualSource {
  label: string;
  url: string;
}

interface VisualBase {
  id: string;
  sources: VisualSource[];
}

export interface VisualMetric extends VisualBase {
  type: "metric";
  label: string;
  value: string | number;
  detail: string | undefined;
}

export interface VisualTable extends VisualBase {
  type: "table";
  title: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface VisualChart extends VisualBase {
  type: "chart";
  title: string;
  xLabel: string | undefined;
  yLabel: string | undefined;
  points: Array<{ label: string; value: number }>;
}

export type VisualComponent = VisualMetric | VisualTable | VisualChart;

export const STREAMABLE_UI_LIMITS = {
  characters: 128_000,
  records: 512,
  components: 24,
  items: 200,
  columns: 12,
  text: 2_000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length <= STREAMABLE_UI_LIMITS.text;
}

function optionalText(value: unknown): value is string | undefined {
  return value === undefined || isText(value);
}

function isLabel(value: unknown): value is string {
  return isText(value) && value.trim().length > 0 && value.length <= 200;
}

function optionalLabel(value: unknown): value is string | undefined {
  return value === undefined || isLabel(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12;
}

function isCell(value: unknown): value is string | number | null {
  return value === null || isText(value) || isNumber(value);
}

function sourcesFrom(value: unknown): VisualSource[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const sources: VisualSource[] = [];
  for (const source of value) {
    if (
      !isRecord(source) ||
      !onlyKeys(source, ["label", "url"]) ||
      !isLabel(source.label) ||
      !isText(source.url) ||
      // oxlint-disable-next-line eslint/no-control-regex -- URL parsing strips controls; reject them before normalization.
      /[\s\u0000-\u001f\u007f]/.test(source.url)
    ) {
      return undefined;
    }
    try {
      const url = new URL(source.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        return undefined;
      }
      sources.push({ label: source.label, url: url.href });
    } catch {
      return undefined;
    }
  }
  return sources;
}

function applyRecord(value: unknown, components: VisualComponent[]): boolean {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string") {
    return false;
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value.id)) return false;
  const target = components.find((component) => component.id === value.id);
  switch (value.type) {
    case "row": {
      if (
        !onlyKeys(value, ["type", "id", "cells"]) ||
        target?.type !== "table" ||
        target.rows.length >= STREAMABLE_UI_LIMITS.items ||
        !Array.isArray(value.cells) ||
        value.cells.length !== target.columns.length ||
        !value.cells.every(isCell)
      ) {
        return false;
      }
      target.rows.push(value.cells);
      return true;
    }
    case "point": {
      if (
        !onlyKeys(value, ["type", "id", "label", "value"]) ||
        target?.type !== "chart" ||
        target.points.length >= STREAMABLE_UI_LIMITS.items ||
        !isLabel(value.label) ||
        !isNumber(value.value)
      ) {
        return false;
      }
      target.points.push({ label: value.label, value: value.value });
      return true;
    }
    default:
      break;
  }
  if (target || components.length >= STREAMABLE_UI_LIMITS.components) return false;
  const sources = sourcesFrom(value.sources);
  if (!sources) return false;
  switch (value.type) {
    case "metric":
      if (
        !onlyKeys(value, ["type", "id", "label", "value", "detail", "sources"]) ||
        !isLabel(value.label) ||
        !(isText(value.value) || isNumber(value.value)) ||
        !optionalText(value.detail)
      ) {
        return false;
      }
      components.push({
        type: "metric",
        id: value.id,
        label: value.label,
        value: value.value,
        detail: value.detail,
        sources,
      });
      return true;
    case "table":
      if (
        !onlyKeys(value, ["type", "id", "title", "columns", "sources"]) ||
        !isLabel(value.title) ||
        !Array.isArray(value.columns) ||
        value.columns.length < 1 ||
        value.columns.length > STREAMABLE_UI_LIMITS.columns ||
        !value.columns.every(isLabel)
      ) {
        return false;
      }
      components.push({
        type: "table",
        id: value.id,
        title: value.title,
        columns: value.columns,
        rows: [],
        sources,
      });
      return true;
    case "chart":
      if (
        !onlyKeys(value, ["type", "id", "title", "xLabel", "yLabel", "sources"]) ||
        !isLabel(value.title) ||
        !optionalLabel(value.xLabel) ||
        !optionalLabel(value.yLabel)
      ) {
        return false;
      }
      components.push({
        type: "chart",
        id: value.id,
        title: value.title,
        xLabel: value.xLabel,
        yLabel: value.yLabel,
        points: [],
        sources,
      });
      return true;
    default:
      return false;
  }
}

/** A record commits only after JSON.parse succeeds. Never repair a partial number
 * or string: it could otherwise briefly display a fabricated price or citation.
 */
export function parseStreamableUi(code: string, isStreaming: boolean) {
  const components: VisualComponent[] = [];
  if (code.length > STREAMABLE_UI_LIMITS.characters) {
    return { components, pending: false, error: "Visual exceeds the size limit." };
  }
  const lines = code.split("\n");
  let records = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    records++;
    if (records > STREAMABLE_UI_LIMITS.records) {
      return { components, pending: false, error: "Visual exceeds the record limit." };
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (isStreaming && index === lines.length - 1) {
        return { components, pending: true, error: undefined };
      }
      return { components, pending: false, error: `Invalid visual JSON on line ${index + 1}.` };
    }
    if (!applyRecord(value, components)) {
      return {
        components,
        pending: false,
        error: `Unsupported visual record on line ${index + 1}.`,
      };
    }
  }
  return {
    components,
    pending: isStreaming,
    error: components.length === 0 && !isStreaming ? "Visual has no components." : undefined,
  };
}
