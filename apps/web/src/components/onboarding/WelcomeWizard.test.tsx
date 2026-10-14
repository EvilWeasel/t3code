// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type AgentSessionImportOutcome,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  importThreads: vi.fn(),
  createProject: vi.fn(),
  complete: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  canOperate: true,
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => mocks.canOperate,
  useEnvironmentsWithScope: (environments: Array<{ environmentId: string }>) =>
    mocks.canOperate ? new Set(environments.map((entry) => entry.environmentId)) : new Set(),
  readEnvironmentScope: () => mocks.canOperate,
}));
vi.mock("../../state/agentSessions", () => ({ agentSessionImport: "import" }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "import"
      ? mocks.importThreads
      : command === "create"
        ? mocks.createProject
        : mocks.refresh,
}));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => mocks.complete }));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  readProjects: () => mocks.projects,
}));
vi.mock("../../state/environments", () => {
  const environment = {
    environmentId: "test-env",
    label: "Computer",
    connection: { phase: "connected" },
    entry: { enabled: true },
  };
  return {
    useEnvironments: () => ({ environments: [environment] }),
    usePrimaryEnvironment: () => environment,
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => [],
    configValueAtom: () => null,
    refreshProviders: "refresh",
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../../onboarding/useProjectScans", () => ({
  useProjectScans: () => [
    {
      environmentId: "test-env",
      isPending: false,
      error: null,
      refresh: mocks.refresh,
      data: {
        truncated: false,
        candidates: [
          {
            path: "/project",
            title: "project",
            projectId: "test-project",
            threadCount: 29,
            lastActiveAt: new Date().toISOString(),
            sources: ["codex"],
          },
        ],
      },
    },
  ],
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../clerk/useT3ConnectAuthPrompt", () => ({ useT3ConnectAuthPrompt: vi.fn() }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: () => null,
  AddManagedCodexAccountDialog: () => null,
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast, close: vi.fn(), update: vi.fn() },
}));

import { WelcomeWizard } from "./WelcomeWizard";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.projects = [{ id: "test-project", environmentId: "test-env", workspaceRoot: "/project" }];
  mocks.canOperate = true;
  mocks.complete.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.importThreads.mockResolvedValue({
    _tag: "Success",
    value: { importedCount: 28, skippedCount: 1 },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

function importOutcome(overrides: Partial<AgentSessionImportOutcome>): AgentSessionImportOutcome {
  return {
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: null,
    status: "imported",
    recoverability: "conversation",
    reason: "imported",
    nativeContinuationEligible: false,
    ...overrides,
  };
}

async function reachImportStep(onDone = vi.fn()) {
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  return onDone;
}

it("enters the workspace after a partial import and warns after navigation finishes", async () => {
  let finishNavigation = () => {};
  const navigation = new Promise<void>((resolve) => {
    finishNavigation = resolve;
  });
  const onDone = vi.fn(() => navigation);
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  await click("Import 1 project");
  expect(onDone).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("test-env"),
    projectId: ProjectId.make("test-project"),
  });
  expect(mocks.toast).not.toHaveBeenCalled();
  await act(async () => finishNavigation());
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      description: "Imported 28 threads. 1 thread could not be imported.",
    }),
  );
  expect(mocks.toast.mock.invocationCallOrder[0]).toBeGreaterThan(
    onDone.mock.invocationCallOrder[0]!,
  );
});

it.each([
  [0, 0, null],
  [29, 0, null],
  [1, 0, null],
  [0, 1, "1 thread could not be imported."],
  [0, 2, "2 threads could not be imported."],
] as const)(
  "finishes setup with %i imported and %i skipped threads",
  async (importedCount, skippedCount, warning) => {
    mocks.importThreads.mockResolvedValue({
      _tag: "Success",
      value: { importedCount, skippedCount },
    });
    const onDone = vi.fn();
    await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
    await click("Continue");
    await click("Continue");
    await click("Import 1 project");
    expect(onDone).toHaveBeenCalledOnce();
    if (warning === null && importedCount > 0) {
      expect(mocks.toast).toHaveBeenCalledWith({
        type: "success",
        title: `Imported ${importedCount} ${importedCount === 1 ? "thread" : "threads"}`,
      });
    } else if (warning === null) {
      expect(mocks.toast).not.toHaveBeenCalled();
    } else {
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "warning", description: warning }),
      );
    }
  },
);

it("explains preserved opaque encrypted context alongside 55 imported conversations", async () => {
  const opaqueOutcomes = Array.from({ length: 6 }, (_, index) =>
    importOutcome({
      providerSessionId: `opaque-fixture-${index}`,
      status: "skipped",
      recoverability: "compaction-context",
      reason: "opaque-context",
    }),
  );
  const importedOutcomes = Array.from({ length: 55 }, () => importOutcome({}));
  mocks.importThreads.mockResolvedValue({
    _tag: "Success",
    value: {
      importedCount: 55,
      skippedCount: 6,
      outcomes: [...importedOutcomes, ...opaqueOutcomes],
    },
  });
  const onDone = await reachImportStep();
  await click("Import 1 project");

  expect(onDone).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      description:
        "Imported 55 conversations. 6 native sessions contained opaque encrypted compaction context. Their original session data was preserved; no conversation or runtime session was imported, and native continuation is not verified.",
    }),
  );
  const description = mocks.toast.mock.calls[0]?.[0]?.description as string;
  expect(description).not.toContain("opaque-fixture");
  expect(description).not.toContain("could not be imported");
});

it("keeps detailed skip reasons separate and reports an unclassified remainder", async () => {
  mocks.importThreads.mockResolvedValue({
    _tag: "Success",
    value: {
      importedCount: 1,
      skippedCount: 5,
      outcomes: [
        importOutcome({
          status: "skipped",
          reason: "opaque-context",
          recoverability: "compaction-context",
        }),
        importOutcome({
          status: "skipped",
          reason: "missing-session-id",
          recoverability: "metadata-only",
        }),
        importOutcome({
          status: "skipped",
          reason: "malformed-compaction",
          recoverability: "unrecoverable",
        }),
        importOutcome({
          status: "skipped",
          reason: "budget-exceeded",
          recoverability: "unrecoverable",
        }),
        importOutcome({ status: "duplicate", reason: "duplicate" }),
      ],
    },
  });
  await reachImportStep();
  await click("Import 1 project");

  const description = mocks.toast.mock.calls[0]?.[0]?.description as string;
  expect(description).toContain("Imported 1 conversation.");
  expect(description).toContain("1 native session contained opaque encrypted compaction context.");
  expect(description).toContain("1 session lacked a recorded native session ID needed for import.");
  expect(description).toContain("1 session had malformed compaction data and was not imported.");
  expect(description).toContain(
    "1 session was left untouched because the import budget was reached.",
  );
  expect(description).toContain(
    "1 additional session was skipped, but the server did not provide a reason.",
  );
  expect(description).not.toContain("duplicate");
});

it("ignores a late DOM import completion after onboarding leaves the import step", async () => {
  let resolveImport!: (result: {
    _tag: "Success";
    value: { importedCount: number; skippedCount: number };
  }) => void;
  mocks.importThreads.mockImplementationOnce(
    () => new Promise((resolve) => (resolveImport = resolve)),
  );
  const onDone = await reachImportStep();
  await click("Import 1 project");
  expect(mocks.importThreads).toHaveBeenCalledOnce();

  await act(async () => root.render(null));
  await act(async () => {
    resolveImport({ _tag: "Success", value: { importedCount: 1, skippedCount: 1 } });
  });

  expect(onDone).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("keeps denied DOM import read-only and still allows setup to finish", async () => {
  const onDone = await reachImportStep();
  mocks.canOperate = false;
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));

  const importButton = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes("Import 1 project"),
  );
  expect(importButton?.disabled).toBe(true);
  expect(document.body.textContent).toContain(
    "This connection cannot import projects or thread history.",
  );
  await click("Do not import projects");

  expect(mocks.createProject).not.toHaveBeenCalled();
  expect(mocks.importThreads).not.toHaveBeenCalled();
  expect(onDone).toHaveBeenCalledOnce();
});

it("keeps setup open when saving completion fails and preserves the import warning on retry", async () => {
  mocks.complete.mockRejectedValueOnce(new Error("settings unavailable"));
  const onDone = vi.fn();
  await act(async () => root.render(<WelcomeWizard localAvailable onDone={onDone} />));
  await click("Continue");
  await click("Continue");
  await click("Import 1 project");
  expect(onDone).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Could not finish setup" }),
  );
  await click("Do not import projects");
  expect(onDone).toHaveBeenCalledOnce();
  expect(mocks.importThreads).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "warning",
      description: "Imported 28 threads. 1 thread could not be imported.",
    }),
  );
});
