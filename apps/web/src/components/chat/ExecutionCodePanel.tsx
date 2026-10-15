import type { EnvironmentId, OrchestrationV2TurnItem, ScopedThreadRef } from "@t3tools/contracts";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import * as DateTime from "effect/DateTime";
import { Suspense, useMemo, useState } from "react";
import {
  executionCode,
  matchesExecutionTarget,
  type ExecutionCodeTarget,
} from "../../lib/executionCode";
import { embeddedScripts } from "../../lib/embeddedScripts";
import { useTurnItemDetail } from "../../state/queries";
import { useTheme } from "../../hooks/useTheme";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { HighlightedTokens } from "./HighlightedTokens";

export interface ExecutionCodePanelProps {
  readonly threadRef: ScopedThreadRef;
  readonly target: ExecutionCodeTarget;
  readonly environmentLabel?: string | undefined;
  readonly wireItem?: OrchestrationV2TurnItem | undefined;
}

/** Uses the same authorized on-demand item read as the timeline inspector. */
export function ExecutionCodePanel(props: ExecutionCodePanelProps) {
  const validWire =
    props.wireItem && matchesExecutionTarget(props.wireItem, props.target)
      ? props.wireItem
      : undefined;
  const detail = useTurnItemDetail({
    environmentId: props.threadRef.environmentId,
    threadId: props.target.threadId,
    itemId: props.target.itemId,
    revision: validWire ? turnItemDetailRevision(validWire) : "restored",
  });
  const fetched = detail.data?.item;
  const fresh =
    fetched &&
    matchesExecutionTarget(fetched, props.target) &&
    (!validWire ||
      DateTime.toEpochMillis(fetched.updatedAt) >= DateTime.toEpochMillis(validWire.updatedAt))
      ? fetched
      : undefined;
  // The command projection retains full input; detail reads cap large strings.
  const item =
    fresh?.type === "command_execution" && validWire?.type === "command_execution"
      ? { ...fresh, input: validWire.input }
      : (fresh ?? validWire);
  return (
    <ExecutionCodeView
      key={`${props.threadRef.environmentId}:${props.target.threadId}:${props.target.itemId}`}
      environmentId={props.threadRef.environmentId}
      environmentLabel={props.environmentLabel}
      target={props.target}
      item={item}
      pending={detail.isPending}
      error={detail.error !== null}
    />
  );
}

export function ExecutionCodeView(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel?: string | undefined;
  readonly target: ExecutionCodeTarget;
  readonly item?: OrchestrationV2TurnItem | undefined;
  readonly pending: boolean;
  readonly error: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const item =
    props.item && matchesExecutionTarget(props.item, props.target) ? props.item : undefined;
  const code = useMemo(() => (item ? executionCode(item) : null), [item]);
  const embedded = useMemo(
    () =>
      code?.text && code.shell && code.language === "shellscript" ? embeddedScripts(code.text) : [],
    [code],
  );
  const [query, setQuery] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const matches = useMemo(() => {
    if (!query || !code?.text) return [];
    return code.text
      .split(/\r?\n/u)
      .flatMap((line, index) =>
        line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [index + 1] : [],
      );
  }, [code, query]);
  const time = (value: OrchestrationV2TurnItem["startedAt"] | undefined) =>
    value ? DateTime.formatIso(value) : "Not supplied";
  return (
    <section aria-label="Execution code" className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
      <h2 className="text-sm font-medium">{code?.title ?? "Recorded input unavailable"}</h2>
      <dl className="my-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs wrap-break-word">
        <dt>Environment / host</dt>
        <dd>{props.environmentLabel ?? props.environmentId}</dd>
        <dt>Environment ID</dt>
        <dd>{props.environmentId}</dd>
        <dt>Thread</dt>
        <dd>{props.target.threadId}</dd>
        <dt>Run</dt>
        <dd>{props.target.runId ?? "Not supplied"}</dd>
        <dt>Item</dt>
        <dd>{props.target.itemId}</dd>
        <dt>Observed status</dt>
        <dd>{item?.status ?? "Unavailable"}</dd>
        <dt>Working directory</dt>
        <dd>{code?.cwd ?? "Not supplied for this execution"}</dd>
        <dt>Started</dt>
        <dd>{time(item?.startedAt)}</dd>
        <dt>Completed</dt>
        <dd>{time(item?.completedAt)}</dd>
        <dt>Exit code</dt>
        <dd>{code?.exitCode ?? "Not supplied"}</dd>
      </dl>
      <p className="mb-3 text-xs text-muted-foreground">
        Recorded provider input. A script filename does not include its historical file contents.
        Opening this view does not run code.
      </p>
      {code?.inputField ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Original input field: {code.inputField}
        </p>
      ) : null}
      {code?.text !== null && code?.text !== undefined ? (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <label className="min-w-0 flex-1 text-xs">
              Find in recorded input
              <input
                aria-label="Find in recorded input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="mt-1 block w-full rounded-sm border border-input bg-background px-2 py-1"
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(code.text!);
                  setCopyState("copied");
                } catch {
                  setCopyState("failed");
                }
              }}
            >
              Copy input
            </Button>
          </div>
          <p role="status" className="mb-2 text-xs text-muted-foreground">
            {query
              ? matches.length
                ? `Matches on lines ${matches.join(", ")}`
                : "No matches"
              : ""}
            {copyState === "copied"
              ? " Input copied."
              : copyState === "failed"
                ? " Could not copy input."
                : ""}
          </p>
          <pre
            aria-label="Recorded input"
            tabIndex={0}
            className="min-h-40 shrink-0 overflow-auto border border-border p-3 font-mono text-xs whitespace-pre select-text"
          >
            <RenderErrorBoundary fallback={code.text} resetKeys={[code.text]}>
              <Suspense fallback={code.text}>
                <HighlightedTokens
                  code={code.text}
                  language={code.language}
                  embedded={embedded}
                  theme={resolvedTheme}
                />
              </Suspense>
            </RenderErrorBoundary>
          </pre>
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {props.pending
            ? "Loading recorded input…"
            : (code?.unavailable ?? "Recorded input is unavailable for this item.")}
          {props.error ? " The authorized item read failed." : ""}
        </p>
      )}
      {code?.argumentsText ? (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer">Complete structured input</summary>
          <pre
            aria-label="Complete structured input"
            tabIndex={0}
            className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap select-text"
          >
            {code.argumentsText}
          </pre>
        </details>
      ) : null}
      <details className="mt-4 text-xs">
        <summary className="cursor-pointer">Output / errors (separate from input)</summary>
        <pre
          aria-label="Recorded output"
          tabIndex={0}
          className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap select-text"
        >
          {code?.output ??
            (props.pending
              ? "Loading output…"
              : code?.outputOmitted
                ? "Complete output is unavailable from the item read."
                : "No output supplied.")}
        </pre>
      </details>
    </section>
  );
}
