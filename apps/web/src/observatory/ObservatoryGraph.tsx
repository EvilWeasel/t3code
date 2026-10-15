import { useId } from "react";
import type { ObservatoryView } from "@t3tools/client-runtime/observatory";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Button } from "../components/ui/button";

/** Edges are exact loaded shell lineage; missing parents remain explicitly outside coverage. */
export function ObservatoryGraph({
  nodes,
  onSelect,
}: {
  readonly nodes: ObservatoryView["nodes"];
  readonly onSelect: (ref: ScopedThreadRef) => void;
}) {
  const arrow = useId();
  const columns = 3;
  const width = 960;
  const cellHeight = 150;
  const position = (index: number) => ({
    x: (index % columns) * 320 + 15,
    y: Math.floor(index / columns) * cellHeight + 20,
  });
  const positions = new Map(nodes.map((node, index) => [node.key, position(index)]));
  const edges = nodes.flatMap((node) => {
    const parent = node.parentKey === null ? undefined : positions.get(node.parentKey);
    const child = positions.get(node.key);
    return parent && child ? [{ parent, child, parentKey: node.parentKey, key: node.key }] : [];
  });
  return (
    <section aria-label="Agent graph">
      <p className="mb-2 text-xs text-muted-foreground">
        {edges.length} observed parent-child edges. Pan horizontally on narrow screens. Parents
        outside this page or loaded coverage have no invented edge.
      </p>
      <div className="overflow-auto rounded-lg border">
        <svg
          width={width}
          height={Math.max(160, Math.ceil(nodes.length / columns) * cellHeight + 20)}
          role="group"
          aria-label="Observed thread relationship graph"
        >
          <defs>
            <marker id={arrow} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" />
            </marker>
          </defs>
          <g className="text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5">
            {edges.map((edge) => (
              <path
                key={edge.key}
                data-parent={edge.parentKey}
                data-child={edge.key}
                aria-label="Observed parent-child relationship"
                d={`M${edge.parent.x + 145},${edge.parent.y + 100} C${edge.parent.x + 145},${edge.parent.y + 135} ${edge.child.x + 145},${edge.child.y - 20} ${edge.child.x + 145},${edge.child.y}`}
                markerEnd={`url(#${arrow})`}
              />
            ))}
          </g>
          {nodes.map((node, index) => {
            const at = position(index);
            return (
              <foreignObject key={node.key} x={at.x} y={at.y} width="290" height="110">
                <div className="h-full overflow-auto rounded-lg border bg-card p-3 text-sm text-foreground">
                  <Button variant="ghost" size="sm-multiline" onClick={() => onSelect(node.ref)}>
                    {node.title}
                  </Button>
                  <p>
                    Observed: {node.nativeStatus}
                    {node.shell.archivedAt !== null && " · archived"}
                  </p>
                  <p className="break-words text-xs text-muted-foreground">
                    {node.ref.environmentId} ·{" "}
                    {node.parentKey === null
                      ? "Root thread"
                      : positions.has(node.parentKey)
                        ? "Parent linked"
                        : node.parentLocation === "outside-page"
                          ? "Parent outside this page"
                          : "Parent outside loaded coverage"}
                  </p>
                </div>
              </foreignObject>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
