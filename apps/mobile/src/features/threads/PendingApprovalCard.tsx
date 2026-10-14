import { RequestActionButton } from "./RequestActionButton";
import type {
  EnvironmentId,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeMode,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly environmentId?: EnvironmentId | undefined;
  readonly environmentLabel?: string | null | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}
const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];
const titles = {
  command: "Run a command",
  "file-read": "Read files",
  "file-change": "Change files",
  "mcp-elicitation": "Allow app access",
  permission: "Grant provider permission",
};
const modeLabels: Record<RuntimeMode, string> = {
  "approval-required": "Ask before actions",
  "auto-accept-edits": "Auto accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options = props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const key = `${props.environmentId ?? "unknown"}:${props.approval.requestId}`;
  const latest = useRef(props);
  latest.current = props;
  const inFlight = useRef(new Set<string>());
  const [, refreshResponses] = useState(0);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const canRespond = props.approval.responseCapability === "live";
  const disabled =
    !canRespond ||
    !props.canOperateThread ||
    props.respondingApprovalId === props.approval.requestId ||
    inFlight.current.has(key);
  const respond = async (decision: ProviderApprovalDecision) => {
    const current = latest.current;
    if (
      current.environmentId !== props.environmentId ||
      current.approval.requestId !== props.approval.requestId ||
      current.onRespond !== props.onRespond ||
      !current.canOperateThread ||
      current.approval.responseCapability !== "live" ||
      current.respondingApprovalId === props.approval.requestId ||
      !(current.approval.options ?? DEFAULT_APPROVAL_OPTIONS).some(
        (option) => option.decision === decision,
      ) ||
      inFlight.current.has(key)
    )
      return;
    inFlight.current.add(key);
    refreshResponses((value) => value + 1);
    setFailedKey(null);
    try {
      await props.onRespond(props.approval.requestId, decision);
    } catch {
      if (
        latest.current.environmentId === props.environmentId &&
        latest.current.approval.requestId === props.approval.requestId
      )
        setFailedKey(key);
    } finally {
      inFlight.current.delete(key);
      refreshResponses((value) => value + 1);
    }
  };
  return (
    <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="font-t3-bold text-lg text-foreground">
          {titles[props.approval.requestKind]}
        </Text>
        <Text className="font-t3-bold text-xs text-warning-foreground">
          {canRespond ? "Decision needed" : "Provider disconnected"}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-3">
        <View className="min-w-32 flex-1 gap-1">
          <Text className="text-xs text-foreground-muted">Destination environment</Text>
          <Text className="font-t3-bold text-sm text-foreground">
            {props.environmentLabel || props.environmentId || "Not supplied"}
          </Text>
        </View>
        <View className="min-w-32 flex-1 gap-1">
          <Text className="text-xs text-foreground-muted">Configured mode</Text>
          <Text className="font-t3-bold text-sm text-foreground">
            {props.runtimeMode ? modeLabels[props.runtimeMode] : "Not supplied"}
          </Text>
        </View>
      </View>
      {props.approval.appName ? (
        <Text className="text-sm text-foreground-secondary">{props.approval.appName}</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-x-3 gap-y-1">
        <Text className="text-xs text-warning-foreground">Requested</Text>
        <Text className="text-xs text-foreground-muted">Execution unconfirmed</Text>
        <Text className="text-xs text-foreground-muted">Verification unconfirmed</Text>
      </View>
      {options.map((option) =>
        option.warning ? (
          <Text key={option.decision} className="text-xs leading-normal text-warning-foreground">
            {option.label}: {option.warning}
          </Text>
        ) : null,
      )}
      {!canRespond ? (
        <Text className="text-sm leading-5 text-foreground-muted">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {options.map((option) => (
          <RequestActionButton
            key={option.decision}
            label={option.label}
            tone={
              option.decision === "accept"
                ? "primary"
                : option.decision === "decline"
                  ? "danger"
                  : "secondary"
            }
            disabled={disabled}
            onPress={() => void respond(option.decision)}
          />
        ))}
      </View>
      {options.length === 0 ? (
        <Text className="text-xs text-foreground-muted">
          No decisions supplied by the provider.
        </Text>
      ) : null}
      {failedKey === key ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          Could not send this decision. The request is still pending.
        </Text>
      ) : null}
      {!props.canOperateThread ? (
        <Text className="text-xs text-foreground-muted">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
      <RequestActionButton
        label={detailsFor === key ? "Hide provider details" : "Show provider details"}
        tone="secondary"
        onPress={() => setDetailsFor((current) => (current === key ? null : key))}
      />
      {detailsFor === key ? (
        <View className="gap-2 border-t border-border pt-3">
          <Text selectable className="font-mono text-sm leading-normal text-foreground-secondary">
            {props.approval.detail || "No details supplied"}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            Environment ID: {props.environmentId ?? "Not supplied"}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            Request: {props.approval.requestId}
          </Text>
          <Text className="text-xs text-foreground-muted">
            Requested at: {props.approval.createdAt}
          </Text>
          <Text className="text-xs text-foreground-muted">OS privilege: Not supplied</Text>
          <Text className="text-xs text-foreground-muted">
            Effective provider policy: Not supplied
          </Text>
          <Text className="text-xs text-foreground-muted">
            Structured resource scope: Not supplied
          </Text>
        </View>
      ) : null}
    </View>
  );
}
