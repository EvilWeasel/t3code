import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { memo, useRef, useState } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const latest = useRef({
    requestId,
    disabled,
    isResponding,
    canRespond,
    options,
    onRespondToApproval,
  });
  latest.current = { requestId, disabled, isResponding, canRespond, options, onRespondToApproval };
  const inFlight = useRef(new Map<RuntimeRequestId, Set<typeof onRespondToApproval>>());
  const [, refreshResponses] = useState(0);
  const [failedRequest, setFailedRequest] = useState<{
    requestId: RuntimeRequestId;
    responder: typeof onRespondToApproval;
  } | null>(null);
  const responseDisabled =
    disabled ||
    isResponding ||
    !canRespond ||
    inFlight.current.get(requestId)?.has(onRespondToApproval) === true;
  const respond = async (decision: ProviderApprovalDecision) => {
    const current = latest.current;
    if (
      current.requestId !== requestId ||
      current.onRespondToApproval !== onRespondToApproval ||
      current.disabled ||
      current.isResponding ||
      !current.canRespond ||
      !current.options.some((option) => option.decision === decision) ||
      inFlight.current.get(requestId)?.has(onRespondToApproval) === true
    )
      return;
    let requests = inFlight.current.get(requestId);
    if (!requests) inFlight.current.set(requestId, (requests = new Set()));
    requests.add(onRespondToApproval);
    refreshResponses((value) => value + 1);
    setFailedRequest(null);
    try {
      await onRespondToApproval(requestId, decision);
    } catch {
      if (
        latest.current.requestId === requestId &&
        latest.current.onRespondToApproval === onRespondToApproval
      )
        setFailedRequest({ requestId, responder: onRespondToApproval });
    } finally {
      const requests = inFlight.current.get(requestId);
      requests?.delete(onRespondToApproval);
      if (requests?.size === 0) inFlight.current.delete(requestId);
      refreshResponses((value) => value + 1);
    }
  };
  const primaryOptions = options.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = options.filter(
    (option) => option.decision !== "decline" && option.decision !== "accept",
  );

  return (
    <>
      {primaryOptions.map((option) => {
        const button = (
          <Button
            key={option.decision}
            size="xs"
            variant={option.decision === "accept" ? "default" : "outline"}
            disabled={responseDisabled}
            aria-description={option.warning}
            onClick={() => {
              void respond(option.decision);
            }}
          >
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="max-w-40 whitespace-normal wrap-break-word">{option.label}</span>
          </Button>
        );
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{option.warning}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={responseDisabled}
            render={<Button size="icon-xs" variant="outline" aria-label="More approval options" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={responseDisabled}
                  aria-description={option.warning}
                  onClick={() => {
                    void respond(option.decision);
                  }}
                  variant="ghost"
                  className="mb-1 last:mb-0"
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="min-w-0 whitespace-normal wrap-break-word">{option.label}</span>
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
      {failedRequest?.requestId === requestId && failedRequest.responder === onRespondToApproval ? (
        <span role="status" className="text-xs text-destructive">
          Could not send this decision. The request is still pending.
        </span>
      ) : null}
    </>
  );
});
