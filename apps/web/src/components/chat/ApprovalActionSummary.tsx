import type { EnvironmentId, RuntimeMode } from "@t3tools/contracts";
import {
  AppWindowIcon,
  FilePenIcon,
  FileSearchIcon,
  KeyRoundIcon,
  TerminalIcon,
} from "lucide-react";
import type { PendingApproval } from "../../session-logic";
import { Badge } from "../ui/badge";
import { cn } from "~/lib/utils";

const presentations = {
  command: { title: "Run a command", label: "Command approval", icon: TerminalIcon },
  "file-read": { title: "Read files", label: "File read approval", icon: FileSearchIcon },
  "file-change": { title: "Change files", label: "File change approval", icon: FilePenIcon },
  "mcp-elicitation": {
    title: "Allow app access",
    label: "App access approval",
    icon: AppWindowIcon,
  },
  permission: {
    title: "Grant provider permission",
    label: "App permission approval",
    icon: KeyRoundIcon,
  },
};
const modeLabels: Record<RuntimeMode, string> = {
  "approval-required": "Ask before actions",
  "auto-accept-edits": "Auto accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export interface ApprovalActionSummaryProps {
  readonly approval: PendingApproval | null;
  readonly pendingCount?: number;
  /** The request's thread environment, never an unrelated composer destination. */
  readonly environmentId?: EnvironmentId | undefined;
  readonly environmentLabel?: string | null | undefined;
  /** Configured thread mode; does not establish effective provider or OS permissions. */
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly className?: string | undefined;
}

export function ApprovalActionSummary({
  approval,
  pendingCount = 1,
  environmentId,
  environmentLabel,
  runtimeMode,
  className,
}: ApprovalActionSummaryProps) {
  if (approval === null) return null;
  const presentation = presentations[approval.requestKind];
  const Icon = presentation.icon;
  const live = approval.responseCapability === "live";
  const warnings = [
    ...new Set(
      approval.options?.flatMap((option) => (option.warning ? [option.warning] : [])) ?? [],
    ),
  ];
  return (
    <section
      aria-label={presentation.label}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon aria-hidden className="size-4 shrink-0 text-warning" />
        <span className="text-xs font-medium text-foreground">{presentation.title}</span>
        <Badge variant={live ? "warning" : "secondary"} size="sm">
          {live ? "Decision needed" : "Provider disconnected"}
        </Badge>
        {pendingCount > 1 ? (
          <span className="ml-auto text-2xs tabular-nums text-muted-foreground">
            1/{pendingCount}
          </span>
        ) : null}
      </div>
      <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 text-2xs sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-muted-foreground">Destination environment</dt>
          <dd className="wrap-break-word text-foreground">
            {environmentLabel || environmentId || "Not supplied"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Resource / app</dt>
          <dd className="wrap-break-word text-foreground">
            {approval.appName || "See provider details"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Configured mode</dt>
          <dd className="text-foreground">
            {runtimeMode ? modeLabels[runtimeMode] : "Not supplied"}
          </dd>
        </div>
      </dl>
      <div
        className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 text-2xs"
        aria-label="Approval scope choices"
      >
        <span className="text-muted-foreground">Provider choices</span>
        {approval.options === undefined ? (
          <span>Default responses</span>
        ) : approval.options.length === 0 ? (
          <span>No decisions supplied</span>
        ) : (
          <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
            {approval.options.map((option) => (
              <li key={option.decision} className="min-w-0 wrap-break-word">
                {option.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {warnings.map((warning) => (
        <p key={warning} className="text-2xs text-warning">
          {warning}
        </p>
      ))}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-2xs" aria-label="Action evidence">
        <span className="text-warning">Requested</span>
        <span className="text-muted-foreground">Execution unconfirmed</span>
        <span className="text-muted-foreground">Verification unconfirmed</span>
      </div>
      {!live ? (
        <p role="status" className="text-xs text-muted-foreground">
          Provider process is gone — interrupt or restart the run to respond.
        </p>
      ) : null}
      <details
        key={`${environmentId ?? "unknown"}:${approval.requestId}`}
        className="min-w-0 text-xs"
      >
        <summary className="cursor-pointer text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Provider details
        </summary>
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          <pre
            aria-label={approval.requestKind === "command" ? "Command" : "Provider request details"}
            data-approval-detail="complete"
            tabIndex={0}
            className="max-h-48 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs wrap-break-word focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {approval.detail || "No details supplied"}
          </pre>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-2xs text-muted-foreground">
            <dt>Request</dt>
            <dd className="wrap-break-word">{approval.requestId}</dd>
            <dt>Environment ID</dt>
            <dd className="wrap-break-word">{environmentId ?? "Not supplied"}</dd>
            <dt>Requested at</dt>
            <dd>
              <time dateTime={approval.createdAt}>{approval.createdAt}</time>
            </dd>
            <dt>OS privilege</dt>
            <dd>Not supplied</dd>
            <dt>Effective provider policy</dt>
            <dd>Not supplied</dd>
            <dt>Structured resource scope</dt>
            <dd>Not supplied</dd>
          </dl>
        </div>
      </details>
    </section>
  );
}
