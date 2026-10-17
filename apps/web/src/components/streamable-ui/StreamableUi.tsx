/* oxlint-disable react/no-array-index-key -- Protocol lists only append; positional keys keep existing rows and points mounted, including duplicate values. */
import { memo, useId, useMemo } from "react";

import { chartGeometry } from "./chartGeometry";
import {
  parseStreamableUi,
  type VisualChart,
  type VisualSource,
  type VisualTable,
} from "./protocol";

function Sources({ sources }: { sources: VisualSource[] }) {
  if (sources.length === 0) return null;
  return (
    <ul aria-label="Sources" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {sources.map((source, index) => (
        <li key={index}>
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline">
            {source.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function DataTable({ title, columns, rows }: Pick<VisualTable, "title" | "columns" | "rows">) {
  return (
    <div
      role="region"
      aria-label={title}
      tabIndex={0}
      className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring"
    >
      <table className="w-full text-left text-sm tabular-nums">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index} scope="col" className="border-b border-border px-3 py-2 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} className="border-b border-border/50 px-3 py-2">
                  {cell === null ? "—" : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LineChart({ chart }: { chart: VisualChart }) {
  const id = useId();
  const geometry = chartGeometry(chart.points);
  if (!geometry) return <p className="text-xs text-muted-foreground">No data points yet.</p>;
  return (
    <>
      <svg
        viewBox="0 0 600 200"
        role="img"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        className="block h-auto w-full text-primary"
      >
        <title id={`${id}-title`}>{chart.title}</title>
        <desc id={`${id}-description`}>
          {chart.points.length} points. {chart.xLabel ?? "Category"} versus{" "}
          {chart.yLabel ?? "Value"}. Range {geometry.minimum} to {geometry.maximum}. Exact values
          are available in View data.
        </desc>
        <path d="M52 24 V164 H548" fill="none" className="stroke-border" />
        <polyline
          points={geometry.coordinates.map((point) => `${point.x},${point.y}`).join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
        {geometry.coordinates.map((point, index) => (
          <circle key={index} cx={point.x} cy={point.y} r={3} fill="currentColor">
            <title>
              {chart.points[index]!.label}: {chart.points[index]!.value}
            </title>
          </circle>
        ))}
        <g className="fill-muted-foreground text-xs">
          <text x={52} y={16}>
            {geometry.maximum}
          </text>
          <text x={52} y={156}>
            {geometry.minimum}
          </text>
          <text x={52} y={188}>
            {chart.points[0]!.label.slice(0, 24)}
          </text>
          {chart.points.length > 1 ? (
            <text x={548} y={188} textAnchor="end">
              {chart.points.at(-1)!.label.slice(0, 24)}
            </text>
          ) : null}
        </g>
      </svg>
      {chart.xLabel || chart.yLabel ? (
        <p className="text-xs text-muted-foreground">
          {chart.xLabel ?? "Category"} · {chart.yLabel ?? "Value"}
        </p>
      ) : null}
      <details>
        <summary className="cursor-pointer text-xs underline">
          View data ({chart.points.length} points)
        </summary>
        <DataTable
          title={`${chart.title} data`}
          columns={[chart.xLabel ?? "Category", chart.yLabel ?? "Value"]}
          rows={chart.points.map((point) => [point.label, point.value])}
        />
      </details>
    </>
  );
}

export const StreamableUi = memo(function StreamableUi({
  code,
  isStreaming,
}: {
  code: string;
  isStreaming: boolean;
}) {
  const parsed = useMemo(() => parseStreamableUi(code, isStreaming), [code, isStreaming]);
  return (
    <div
      className="my-3 grid min-w-0 gap-3"
      data-streamable-ui=""
      data-markdown-copy={`\`\`\`t3-ui\n${code}\n\`\`\``}
    >
      {parsed.components.map((component) => (
        <section
          key={component.id}
          aria-label={component.type === "metric" ? component.label : component.title}
          className="grid min-w-0 gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
        >
          {component.type === "metric" ? (
            <dl>
              <dt className="text-xs text-muted-foreground">{component.label}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{component.value}</dd>
              {component.detail ? (
                <dd className="mt-1 text-xs text-muted-foreground">{component.detail}</dd>
              ) : null}
            </dl>
          ) : (
            <>
              <p className="text-sm font-medium">{component.title}</p>
              {component.type === "table" ? (
                <DataTable {...component} />
              ) : (
                <LineChart chart={component} />
              )}
            </>
          )}
          <Sources sources={component.sources} />
        </section>
      ))}
      {parsed.pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Receiving visual data…
        </p>
      ) : null}
      {parsed.error ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{parsed.error} View source</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{code}</pre>
        </details>
      ) : null}
    </div>
  );
});
