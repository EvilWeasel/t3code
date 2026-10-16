// Hosted viewport emulation only. Actual composer/editor/queue, isolated synthetic state.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  MessageId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderOptionSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ChatComposer,
  type ChatComposerProps,
  type ChatComposerHandle,
} from "../../apps/web/src/components/chat/ChatComposer";
import { QueuedRunsControl } from "../../apps/web/src/components/chat/QueuedRunsControl";
import { TooltipProvider } from "../../apps/web/src/components/ui/tooltip";
import { useComposerDraftStore } from "../../apps/web/src/composerDraftStore";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
} from "../../apps/web/src/composerDraftStore";

export const fixtureEnvironment = EnvironmentId.make("composer-mobile-fixture");
const threadId = ThreadId.make("composer-mobile-fixture-thread");
const target = scopeThreadRef(fixtureEnvironment, threadId);
export const provider = {
  driver: ProviderDriverKind.make("codex"),
  instanceId: ProviderInstanceId.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  version: null,
  checkedAt: "2026-10-15T00:00:00.000Z",
  models: ["gpt-6.1-sol", "synthetic-alternate"].map((slug) => ({
    slug,
    name:
      slug === "synthetic-alternate"
        ? "Synthetic alternate model"
        : new URLSearchParams(location.search).get("catalog") === "long"
          ? "GPT-6.1-Sol · synthetic long model and context selection"
          : "GPT-6.1-Sol",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning effort",
          type: "select" as const,
          currentValue: "medium",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
        },
      ],
    },
  })),
  slashCommands: [],
  skills: [],
} satisfies ChatComposerProps["providerStatuses"][number];
export const observation = {
  sends: [] as string[],
  sendContexts: [] as Array<{
    model: string;
    interactionMode: ProviderInteractionMode;
    runtimeMode: RuntimeMode;
    reasoning: string | boolean | null;
    selectedInstance: ProviderInstanceId;
    selectedModel: string;
  }>,
  forbiddenCommands: 0,
  mediaCalls: 0,
  peerCalls: 0,
  modelChoices: [] as Array<{ instanceId: ProviderInstanceId; model: string }>,
  runtimeChoices: [] as RuntimeMode[],
  interactionChoices: [] as ProviderInteractionMode[],
  interactionToggles: 0,
};
Object.defineProperty(window, "composerFixture", { value: observation });
const noop = () => {};
function Fixture() {
  const promptRef = useRef("");
  const images = useRef<ComposerImageAttachment[]>([]);
  const files = useRef<ComposerFileAttachment[]>([]);
  const terminals = useRef<
    ChatComposerProps["composerTerminalContextsRef"]["current"]
  >([]);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const [selection, setSelection] = useState(() =>
    createModelSelection(provider.instanceId, "gpt-6.1-sol"),
  );
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("full-access");
  const [interactionMode, setInteractionMode] =
    useState<ProviderInteractionMode>("default");
  const onProviderModelSelect = useCallback<
    ChatComposerProps["onProviderModelSelect"]
  >((instanceId, model, options) => {
    observation.modelChoices.push({ instanceId, model });
    setSelection(createModelSelection(instanceId, model));
    if (options?.focusComposer !== false) composerRef.current?.focusAtEnd();
  }, []);
  const handleRuntimeModeChange = useCallback((mode: RuntimeMode) => {
    observation.runtimeChoices.push(mode);
    setRuntimeMode(mode);
  }, []);
  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      observation.interactionChoices.push(mode);
      setInteractionMode(mode);
    },
    [],
  );
  const toggleInteractionMode = useCallback(() => {
    observation.interactionToggles++;
    setInteractionMode((current) => (current === "plan" ? "default" : "plan"));
  }, []);
  const readContext = useCallback(() => {
    const context = composerRef.current?.getSendContext();
    if (!context) throw new Error("Synthetic composer context unavailable");
    const options = context.selectedModelOptionsForDispatch;
    if (
      options !== undefined &&
      !Schema.is(Schema.Array(ProviderOptionSelection))(options)
    )
      throw new Error("Unexpected synthetic option shape");
    return {
      model: context.selectedModel,
      interactionMode: context.interactionMode,
      runtimeMode,
      reasoning:
        options?.find((option) => option.id === "reasoningEffort")?.value ??
        null,
      selectedInstance: selection.instanceId,
      selectedModel: selection.model,
    };
  }, [runtimeMode, selection]);
  useEffect(() => {
    Object.defineProperty(window, "readComposerFixtureContext", {
      configurable: true,
      value: readContext,
    });
    return () => {
      Reflect.deleteProperty(window, "readComposerFixtureContext");
    };
  }, [readContext]);
  const props = {
    composerDraftTarget: target,
    environmentId: fixtureEnvironment,
    canOperateThread: true,
    attachmentUploadsCapabilityKnown: true,
    supportsAttachmentUploads: true,
    supportsQuestionAttachments: true,
    maxFileAttachmentBytes: 10485760,
    routeKind: "server",
    routeThreadRef: target,
    draftId: null,
    multipleModelSelections: null,
    supportsMultipleModels: false,
    onMultipleModelSelectionsChange: noop,
    activeThreadId: threadId,
    activeThreadEnvironmentId: fixtureEnvironment,
    activeThread: undefined,
    activeThreadShell: null,
    promptHistoryMessages: [],
    isServerThread: true,
    isLocalDraftThread: false,
    forceExpandedOnMobile: true,
    projectSelectionRequired: false,
    phase: "ready",
    canInterrupt: false,
    isConnecting: false,
    isSendBusy: false,
    canResume: false,
    sendDisabledReason: null,
    isPreparingWorktree: false,
    bannerItems: [],
    resumeCompactionTokens: null,
    keepFullHistory: true,
    onToggleKeepFullHistory: noop,
    environmentUnavailable: null,
    activePendingApproval: null,
    pendingApprovals: [],
    pendingUserInputs: [],
    activePendingProgress: null,
    activePendingResolvedAnswers: null,
    activePendingIsResponding: false,
    activePendingDraftAnswers: {},
    activePendingQuestionIndex: 0,
    respondingRequestIds: [],
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    activeTasksProgress: null,
    activeTaskSteps: null,
    threadSyncPhase: null,
    runtimeMode,
    interactionMode,
    lockedProvider: null,
    providerStatuses: [provider],
    providerCatalogKnown: true,
    activeProjectDefaultModelSelection: createModelSelection(
      provider.instanceId,
      "gpt-6.1-sol",
    ),
    activeThreadModelSelection: selection,
    activeProjectId: null,
    activeContextWindow: {
      usedTokens: 123456,
      totalProcessedTokens: null,
      maxTokens: 1048576,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      lastUsedTokens: null,
      lastInputTokens: null,
      lastCachedInputTokens: null,
      lastOutputTokens: null,
      lastReasoningOutputTokens: null,
      toolUses: null,
      durationMs: null,
      compactsAutomatically: null,
      autoCompactThreshold: null,
      cost: null,
      remainingTokens: 925120,
      usedPercentage: 12,
      remainingPercentage: 88,
      updatedAt: "2026-10-15T00:00:00.000Z",
    },
    compactThreadUnavailable: false,
    compactDisabled: false,
    compactDisabledReason: null,
    resolvedTheme: "dark",
    settings: { ...DEFAULT_UNIFIED_SETTINGS, contextWindowMeterEnabled: true, planModeEnabled: true },
    keybindings: [],
    terminalOpen: false,
    gitCwd: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: undefined,
    restingControlsHost: null,
    restingControlsHaveLeadingContext: false,
    onRestingControlsVisibilityChange: noop,
    getTimelineScrollableNode: () => null,
    isTimelineAtLogicalEnd: () => true,
    timelineOverflows: false,
    onComposerOverlayHeightChange: noop,
    onRestingChange: noop,
    promptRef,
    composerImagesRef: images,
    composerFilesRef: files,
    composerTerminalContextsRef: terminals,
    composerRef,
    onPageScrollKeyDown: noop,
    onPageScrollKeyUp: noop,
    onPageScrollRelease: noop,
    queuedRunsControl: (
      <QueuedRunsControl
        environmentId={fixtureEnvironment}
        threadId={threadId}
        optimisticMessages={Array.from({ length: 17 }, (_, index) => ({
          id: MessageId.make(`fixture-queued-${index}`),
          inputIntent: "queued_turn",
          text: `Synthetic queued task ${index + 1}`,
          attachments: [],
        }))}
        editingRunId={null}
        onEditQueuedRun={noop}
        onCancelEdit={noop}
      />
    ),
    editingQueuedAttachments: null,
    onRemoveEditingQueuedAttachment: noop,
    onCompactContext: noop,
    onSend: async (event) => {
      event?.preventDefault();
      observation.sends.push(promptRef.current);
      observation.sendContexts.push(readContext());
      return true;
    },
    onResume: noop,
    onInterrupt: noop,
    onImplementPlanInNewThread: noop,
    onRespondToApproval: async () => undefined,
    onSelectActivePendingUserInputOption: noop,
    onAdvanceActivePendingUserInput: noop,
    onDismissActivePendingUserInput: noop,
    onPreviousActivePendingUserInputQuestion: noop,
    onChangeActivePendingUserInputCustomAnswer: noop,
    onProviderModelSelect,
    onOpenProviderSetup: noop,
    getModelDisabledReason: () => null,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    focusComposer: () => composerRef.current?.focusAtEnd(),
    scheduleComposerFocus: noop,
    setThreadError: noop,
    onExpandImage: noop,
    onFileOpen: noop,
  } satisfies ChatComposerProps;
  return (
    <RegistryProvider>
      <TooltipProvider delay={0}>
        <main
          data-composer-fixture
          className="flex min-h-dvh flex-col bg-background text-foreground"
        >
          <header className="p-2 text-xs">
            EMULATED viewport · synthetic queue · no provider or microphone
          </header>
          <section className="mt-auto w-full p-2">
            <ChatComposer {...props} />
          </section>
        </main>
      </TooltipProvider>
    </RegistryProvider>
  );
}
export function mountComposerFixture() {
  document.documentElement.className = "dark";
  if (new URLSearchParams(location.search).get("text") === "large")
    document.documentElement.style.fontSize = "20px";
  useComposerDraftStore.getState().setPrompt(target, "");
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing fixture root");
  createRoot(element).render(<Fixture />);
}
