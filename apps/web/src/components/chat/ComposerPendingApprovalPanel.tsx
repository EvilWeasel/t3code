import type { EnvironmentId, RuntimeMode } from "@t3tools/contracts";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { ApprovalActionSummary } from "./ApprovalActionSummary";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  environmentId?: EnvironmentId | undefined;
  runtimeMode?: RuntimeMode | undefined;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel(
  props: ComposerPendingApprovalPanelProps,
) {
  return <ApprovalActionSummary {...props} />;
});
