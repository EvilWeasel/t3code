import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { getProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";

import {
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  describeUpdateEverything,
  getUpdateEverythingToastView,
  resolveUpdateRunMachineStatus,
  runUpdateEverything,
  persistUpdateEverythingResult,
  takeUpdateEverythingResult,
  clearUpdateEverythingResult,
  installAfterUpdateEverything,
  type UpdateEverythingMachine,
  type UpdateRunMachine,
  type UpdateEverythingResult,
  acknowledgeUpdateOutcomeNotice,
  buildUpdateOutcomeRows,
  clearUpdateOutcomeHistory,
  completeUpdateOutcome,
  readUpdateOutcomeHistory,
  resolvePendingUpdateOutcome,
  reservePendingUpdateOutcome,
  updateOutcomeScope,
  writeUpdateOutcomeHistory,
  type LastCompletedUpdate,
  type PendingUpdateInstall,
  type UpdateOutcomeHistory,
} from "./updateEverything.logic";

function machine(
  id: string,
  serverVersion: string,
  selfUpdate: ServerSelfUpdateCapability | undefined,
  overrides: Partial<UpdateEverythingMachine> = {},
): UpdateEverythingMachine {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    serverConfig: {
      environment: {
        environmentId: EnvironmentId.make(id),
        label: id,
        platform: { os: "linux", arch: "x64" },
        serverVersion,
        capabilities: {
          repositoryIdentity: true,
          ...(selfUpdate ? { serverSelfUpdate: selfUpdate } : {}),
          ...(selfUpdate === "desktop-managed" ? { desktopAppUpdate: true } : {}),
        },
      },
      settings: { continueThreadsAfterServerUpdate: false },
    },
    connected: true,
    hostedByThisApp: false,
    canMaintain: true,
    updateState: { status: "idle" },
    ...overrides,
  };
}

describe("collectServerUpdateTargets", () => {
  it("updates remote servers that can move to the target and names every skipped one", () => {
    const { targets, skipped } = collectServerUpdateTargets(
      [
        machine("this-app", "0.0.40", "desktop-managed", { hostedByThisApp: true }),
        machine("service", "0.0.40", "boot-service"),
        machine("nightly-service", "0.0.49-nightly.20261001.3", "boot-service"),
        machine("other-desktop", "0.0.49-nightly.20261001.3", "desktop-managed"),
        machine("offline", "0.0.40", "boot-service", { connected: false }),
        machine("never-connected", "0.0.40", "boot-service", { serverConfig: null }),
        machine("no-scope", "0.0.40", "boot-service", { canMaintain: false }),
        machine("busy", "0.0.40", "boot-service", {
          updateState: {
            status: "running",
            stage: "downloading",
            fromVersion: "0.0.40",
            targetVersion: "0.0.50",
          },
        }),
        machine("current", "0.0.50", "boot-service"),
        machine("current-offline", "0.0.50", "boot-service", { connected: false }),
        machine("manual", "0.0.40", undefined),
      ],
      "0.0.50",
    );

    expect(targets.map((target) => [target.serverLabel, target.targetVersion])).toEqual([
      ["service", "0.0.50"],
      ["other-desktop", "0.0.50"],
    ]);
    expect(skipped.map((entry) => [entry.label, entry.reason])).toEqual([
      ["nightly-service", "on the nightly channel"],
      ["offline", "not connected"],
      ["never-connected", "not connected"],
      ["no-scope", "no permission"],
      ["busy", "already updating"],
      ["manual", "needs a manual update"],
    ]);
  });
  it("keeps current and newer nightly hosts out of an update pass", () => {
    const { targets } = collectServerUpdateTargets(
      [
        machine("older", "0.0.47-nightly.20261014.15", "boot-service"),
        machine("current", "0.0.47-nightly.20261014.16", "boot-service"),
        machine("newer", "0.0.47-nightly.20261014.17", "desktop-managed"),
      ],
      "0.0.47-nightly.20261014.16",
    );
    expect(targets.map((target) => target.serverLabel)).toEqual(["older"]);
  });
});

describe("collectRestartingMachines", () => {
  it("lists updated servers, and this app's servers only when it installs", () => {
    const withContinuation = (
      id: string,
      overrides: Partial<UpdateEverythingMachine> = {},
      enabled = false,
    ) => {
      const base = machine(id, "0.0.40", "boot-service", overrides);
      return {
        ...base,
        serverConfig: {
          environment: {
            ...base.serverConfig!.environment,
            capabilities: {
              ...base.serverConfig!.environment.capabilities,
              threadRestartContinuation: true,
            },
          },
          settings: { continueThreadsAfterServerUpdate: enabled },
        },
      };
    };
    const machines = [
      withContinuation("this-app", { hostedByThisApp: true }, true),
      withContinuation("alvin", {}, true),
      withContinuation("opted-out", {}, false),
      machine("old", "0.0.40", "boot-service"),
      withContinuation("providers-only"),
    ];
    const servers = ["alvin", "opted-out", "old"].map((id) => ({
      environmentId: EnvironmentId.make(id),
    }));

    expect(collectRestartingMachines(machines, servers, true)).toEqual([
      { environmentId: "this-app", continuesThreads: true },
      { environmentId: "alvin", continuesThreads: true },
      { environmentId: "opted-out", continuesThreads: false },
      { environmentId: "old", continuesThreads: false },
    ]);
    expect(
      collectRestartingMachines(machines, servers, false).map((entry) => entry.environmentId),
    ).toEqual(["alvin", "opted-out", "old"]);
  });
});

describe("runUpdateEverything", () => {
  it("restarts servers after providers finish and returns every result", async () => {
    const calls: string[] = [];
    let finishProviders = (_value: string) => {};
    const run = runUpdateEverything({
      downloadLocal: async () => {
        calls.push("download");
        return true;
      },
      updateProviders: () =>
        new Promise<string>((resolve) => {
          calls.push("providers");
          finishProviders = resolve;
        }),
      updateServers: async () => {
        calls.push("servers");
        return 2;
      },
    });

    expect(calls).toEqual(["download", "providers"]);
    finishProviders("provider results");
    expect(await run).toEqual({ localReady: true, providers: "provider results", servers: 2 });
    expect(calls).toEqual(["download", "providers", "servers"]);
  });

  it("still updates remote machines when the local download fails", async () => {
    const calls: string[] = [];
    const result = await runUpdateEverything({
      downloadLocal: async () => false,
      updateProviders: async () => {
        calls.push("providers");
      },
      updateServers: async () => {
        calls.push("servers");
      },
    });

    expect(calls).toEqual(["providers", "servers"]);
    expect(result.localReady).toBe(false);
  });
});

describe("resolveUpdateRunMachineStatus", () => {
  const runMachine = (overrides: Partial<UpdateRunMachine> = {}): UpdateRunMachine => ({
    environmentId: EnvironmentId.make("alvin"),
    label: "alvin",
    updatesProviders: true,
    updatesServer: true,
    result: null,
    ...overrides,
  });
  const running = (stage: "downloading" | "installing" | "resuming") =>
    ({ status: "running", stage, fromVersion: "0.0.40", targetVersion: "0.0.50" }) as const;

  it("follows the run phase, then the server's own update stage", () => {
    const idle = { status: "idle" } as const;
    expect(resolveUpdateRunMachineStatus(runMachine(), "providers", idle)).toBe("providers");
    expect(resolveUpdateRunMachineStatus(runMachine(), "servers", idle)).toBe("waiting");
    expect(resolveUpdateRunMachineStatus(runMachine(), "servers", running("installing"))).toBe(
      "downloading",
    );
    expect(resolveUpdateRunMachineStatus(runMachine(), "servers", running("resuming"))).toBe(
      "restarting",
    );
    expect(
      resolveUpdateRunMachineStatus(
        runMachine({ updatesProviders: false }),
        "providers",
        running("downloading"),
      ),
    ).toBe("downloading");
    expect(resolveUpdateRunMachineStatus(runMachine({ result: "failed" }), "servers", idle)).toBe(
      "failed",
    );
  });
});

describe("update everything summary", () => {
  const result = collectUpdateEverythingResult({
    localVersion: "0.0.50",
    localFailures: ["Could not download update: Network error."],
    servers: [
      { label: "alvin", outcome: { status: "failed", message: "Download failed." } },
      { label: "box", outcome: { status: "updated" } },
      { label: "studio", outcome: { status: "updated" } },
      { label: "busy", outcome: { status: "skipped" } },
    ],
    providers: [
      { status: "updated" },
      { status: "interrupted", line: "Laptop · Codex: Update was interrupted." },
      { status: "failed", line: "box · Codex: npm exited with code 1." },
    ],
  });

  it("counts updates and names the machine of each failure", () => {
    expect(result).toEqual({
      localVersion: "0.0.50",
      updatedServers: 2,
      updatedProviders: 1,
      failures: [
        "This app: Could not download update: Network error.",
        "alvin: Download failed.",
        "box · Codex: npm exited with code 1.",
      ],
      skipped: ["busy: Update was not started.", "Laptop · Codex: Update was interrupted."],
    });
  });

  it("includes this app only when the relaunch landed on its version", () => {
    expect(getUpdateEverythingToastView(result, "0.0.50")).toEqual({
      type: "error",
      title: "Updated this app, 2 servers, and 1 provider",
      description: [
        "This app: Could not download update: Network error.",
        "alvin: Download failed.",
        "box · Codex: npm exited with code 1.",
        "Skipped busy: Update was not started.",
        "Skipped Laptop · Codex: Update was interrupted.",
      ].join("\n"),
    });
    expect(getUpdateEverythingToastView({ ...result, failures: [] }, "0.0.40")).toEqual({
      type: "success",
      title: "Updated 2 servers and 1 provider",
      description: "Skipped busy: Update was not started.\nSkipped Laptop · Codex: Update was interrupted.",
    });
  });

  it("reports a failure when nothing updated, and nothing when nothing finished", () => {
    const empty = { localVersion: null, updatedServers: 0, updatedProviders: 0 };
    expect(
      getUpdateEverythingToastView({ ...empty, failures: ["alvin: offline"] }, "0.0.50"),
    ).toEqual({ type: "error", title: "Update failed", description: "alvin: offline" });
    expect(getUpdateEverythingToastView({ ...empty, failures: [] }, "0.0.50")).toBeNull();
  });
});

describe("update everything relaunch handoff", () => {
  const makeStorage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
  };
  const saved = {
    localVersion: "0.0.50",
    updatedServers: 1,
    updatedProviders: 1,
    failures: ["offline: Could not connect"],
  };

  it("preserves labelled provider interruptions beside successes and failures after relaunch", async () => {
    const baseRun = {
      environmentId: EnvironmentId.make("Laptop"),
      machineLabel: "Laptop",
      driver: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex"),
    };
    const interrupted = getProviderUpdateRunOutcome({
      ...baseRun, result: AsyncResult.failure(Cause.interrupt()),
    });
    const failed = getProviderUpdateRunOutcome({
      ...baseRun, machineLabel: "Server",
      result: AsyncResult.failure(Cause.die(new Error("Installer failed"))),
    });
    const remote = await runUpdateEverything({
      downloadLocal: async () => true,
      updateProviders: async () => [{ status: "updated" } as const, failed, interrupted],
      updateServers: async () => [
        { label: "ready", outcome: { status: "updated" } as const },
      ],
    });
    const result = collectUpdateEverythingResult({
      localVersion: "0.0.50", localFailures: [],
      servers: remote.servers, providers: remote.providers,
    });
    const storage = makeStorage();
    expect(await installAfterUpdateEverything({
      result, localReady: remote.localReady,
      save: (value) => persistUpdateEverythingResult(value, storage, 1_000),
      install: async () => true,
      clear: () => clearUpdateEverythingResult(storage),
    })).toBe("relaunching");
    const restored = takeUpdateEverythingResult(storage, 2_000);
    expect(restored).toMatchObject({
      localVersion: "0.0.50", updatedServers: 1, updatedProviders: 1,
      failures: ["Server · Codex: Installer failed"],
      skipped: ["Laptop · Codex: Update was interrupted."],
    });
    if (restored === null) throw new Error("The saved summary was lost");
    expect(getUpdateEverythingToastView(restored, "0.0.50")).toEqual({
      type: "error", title: "Updated this app, 1 server, and 1 provider",
      description: "Server · Codex: Installer failed\nSkipped Laptop · Codex: Update was interrupted.",
    });
    const onlyInterrupted = collectUpdateEverythingResult({
      localVersion: null, localFailures: [], servers: [], providers: [interrupted],
    });
    expect(persistUpdateEverythingResult(onlyInterrupted, storage, 3_000)).toBe(true);
    const restoredInterruption = takeUpdateEverythingResult(storage, 4_000);
    if (restoredInterruption === null) throw new Error("The interruption summary was lost");
    expect(getUpdateEverythingToastView(restoredInterruption, "0.0.50")).toEqual({
      type: "error", title: "Updates skipped",
      description: "Skipped Laptop · Codex: Update was interrupted.",
    });
  });

  it("retains partial remote results and local intent across a successful relaunch", async () => {
    const storage = makeStorage();
    const remote = await runUpdateEverything({
      downloadLocal: async () => true,
      updateProviders: async () => [{ status: "updated" } as const],
      updateServers: async () => [
        { label: "ready", outcome: { status: "updated" } as const },
        { label: "offline", outcome: { status: "failed", message: "Could not connect" } as const },
      ],
    });
    const result = collectUpdateEverythingResult({
      localVersion: "0.0.50", localFailures: [],
      servers: remote.servers, providers: remote.providers,
    });
    let installs = 0;
    const outcome = await installAfterUpdateEverything({
      result,
      localReady: remote.localReady,
      save: (value) => persistUpdateEverythingResult(value, storage, 1_000),
      install: async () => {
        installs += 1;
        // Simulate the next renderer reading exactly what was saved before quit.
        expect(takeUpdateEverythingResult(storage, 2_000)).toMatchObject(saved);
        return true;
      },
      clear: () => { throw new Error("A relaunch must keep its saved summary"); },
    });
    expect(outcome).toBe("relaunching");
    expect(installs).toBe(1);
    expect(takeUpdateEverythingResult(storage, 2_000)).toBeNull();
  });

  it("consumes a saved summary once and rejects malformed, expired or future records", () => {
    const storage = makeStorage();
    expect(persistUpdateEverythingResult(saved, storage, 1_000)).toBe(true);
    expect(takeUpdateEverythingResult(storage, 1_001)).toMatchObject(saved);
    expect(takeUpdateEverythingResult(storage, 1_001)).toBeNull();
    expect(persistUpdateEverythingResult(saved, storage, 1_000)).toBe(true);
    expect(takeUpdateEverythingResult(storage, 601_000)).toBeNull();
    expect(persistUpdateEverythingResult(saved, storage, 1_000)).toBe(true);
    expect(takeUpdateEverythingResult(storage, 999)).toBeNull();
    const malformed = { ...storage, getItem: () => '{"localVersion":false}' };
    expect(takeUpdateEverythingResult(malformed, 1_001)).toBeNull();
  });

  it("keeps offline skip reasons alongside successful machines through relaunch", () => {
    const result = collectUpdateEverythingResult({
      localVersion: "0.0.50", localFailures: [],
      skipped: [{ environmentId: EnvironmentId.make("offline"), label: "offline", reason: "not connected" }],
      servers: [
        { label: "ready", outcome: { status: "updated" } },
        { label: "interrupted", outcome: { status: "skipped", message: "Update was interrupted." } },
      ],
      providers: [],
    });
    const storage = makeStorage();
    expect(persistUpdateEverythingResult(result, storage, 1_000)).toBe(true);
    const restored = takeUpdateEverythingResult(storage, 2_000);
    expect(restored).toMatchObject({
      updatedServers: 1,
      skipped: ["offline: not connected", "interrupted: Update was interrupted."],
    });
    expect(getUpdateEverythingToastView(result, "0.0.50")).toEqual({
      type: "success", title: "Updated this app and 1 server",
      description: "Skipped offline: not connected\nSkipped interrupted: Update was interrupted.",
    });
    expect(resolveUpdateRunMachineStatus({
      environmentId: EnvironmentId.make("interrupted"), label: "interrupted",
      updatesProviders: false, updatesServer: true, result: "skipped",
    }, "servers", { status: "idle" })).toBe("skipped");
  });

  it("keeps the local app open when storage throws or cannot read back its summary", async () => {
    let installs = 0;
    for (const storage of [
      { ...makeStorage(), setItem: () => { throw new Error("Quota exceeded"); } },
      { ...makeStorage(), getItem: () => "corrupt" },
    ]) {
      const outcome = await installAfterUpdateEverything({
        result: saved, localReady: true,
        save: (value) => persistUpdateEverythingResult(value, storage, 1_000),
        install: async () => { installs += 1; return true; },
        clear: () => {},
      });
      expect(outcome).toBe("storage-failed");
    }
    expect(installs).toBe(0);
  });

  it("does not save or install a failed local download and clears a refused install", async () => {
    let saves = 0;
    let installs = 0;
    const storage = makeStorage();
    const input = {
      result: saved, localReady: false,
      save: (value: UpdateEverythingResult) => { saves += 1; return persistUpdateEverythingResult(value, storage, 1_000); },
      install: async () => { installs += 1; return false; },
      clear: () => clearUpdateEverythingResult(storage),
    };
    expect(await installAfterUpdateEverything(input)).toBe("not-installed");
    expect(saves).toBe(0);
    expect(installs).toBe(0);
    expect(await installAfterUpdateEverything({ ...input, localReady: true })).toBe("not-installed");
    expect(installs).toBe(1);
    expect(takeUpdateEverythingResult(storage, 1_001)).toBeNull();
  });
});

describe("describeUpdateEverything", () => {
  it("summarizes the run and lists each machine once", () => {
    const alvin = EnvironmentId.make("alvin");
    expect(
      describeUpdateEverything({
        localVersion: "0.0.50",
        servers: [
          {
            environmentId: alvin,
            serverLabel: "alvin",
            selfUpdate: "boot-service",
            targetVersion: "0.0.50",
          },
          {
            environmentId: EnvironmentId.make("studio"),
            serverLabel: "studio",
            selfUpdate: "desktop-managed",
            targetVersion: "0.0.50",
          },
        ],
        providerMachines: [
          { environmentId: alvin, label: "alvin", providers: ["Codex", "Claude"] },
          { environmentId: EnvironmentId.make("box"), label: "box", providers: ["Cursor"] },
        ],
      }),
    ).toEqual({
      summary: "Update this app, 2 servers, and 3 providers",
      lines: [
        "This app: 0.0.50, restarts last",
        "alvin: server to 0.0.50, Codex, Claude",
        "studio: desktop app update",
        "box: Cursor",
      ],
    });
  });

  it("reads naturally with one kind of update", () => {
    expect(
      describeUpdateEverything({
        localVersion: null,
        servers: [],
        providerMachines: [
          { environmentId: EnvironmentId.make("alvin"), label: "alvin", providers: ["Codex"] },
        ],
      }).summary,
    ).toBe("Update 1 provider");
  });
});

describe("durable last completed Update all outcome", () => {
  const scope = { surface: "desktop", primaryEnvironmentId: "primary-A" } as const;
  const makeStore = () => {
    const values = new Map<string, string>();
    let removes = 0;
    return {
      values,
      removes: () => removes,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { removes += 1; values.delete(key); },
    };
  };
  const identity = (id: string) => ({
    environmentId: EnvironmentId.make(id), machineLabel: id,
    driver: ProviderDriverKind.make("codex"), instanceId: ProviderInstanceId.make(`codex-${id}`),
  });
  const completed = (id = "completed-1"): LastCompletedUpdate => ({
    id, completedAt: 1_000, clientVersion: "1.2.3", targetVersion: null,
    rows: [{ environmentId: "primary-A", machineLabel: "ready", component: "server",
      driver: null, instanceId: null, status: "updated", reason: "none",
      targetVersion: null, observedVersion: null }],
  });
  const pending = (): PendingUpdateInstall => ({
    id: "install-1", startedAt: 2_000, fromVersion: "1.2.3", targetVersion: "1.2.4",
    previousNotAppliedVersion: null, previousCompletedId: null, rows: completed().rows,
  });
  const read = (store: ReturnType<typeof makeStore>, selected = scope): UpdateOutcomeHistory => {
    const result = readUpdateOutcomeHistory(store, selected);
    if (result.status !== "ready") throw new Error("Expected a readable history");
    return result.value;
  };

  it("retains mixed machine/provider identities after notice consumption, relaunch and 24 hours", () => {
    const store = makeStore();
    const interrupted = getProviderUpdateRunOutcome({
      ...identity("interrupted"), result: AsyncResult.failure(Cause.interrupt()),
    });
    const rows = buildUpdateOutcomeRows({
      providers: [
        { status: "updated", identity: identity("updated"), targetVersion: "2.0", observedVersion: "2.0" },
        { status: "failed", line: "DO NOT PERSIST token=secret / draft / raw stderr", identity: identity("failed") },
        interrupted,
      ],
      servers: [{ environmentId: "ready", label: "ready", targetVersion: "3.0", observedVersion: "2.9", outcome: { status: "updated" } }],
      skipped: [{ environmentId: EnvironmentId.make("offline"), label: "offline", reason: "not connected" }],
    });
    if (rows === null) throw new Error("Missing identity");
    const last = { ...completed(), rows };
    expect(writeUpdateOutcomeHistory(store, scope, (previous) => completeUpdateOutcome(previous, last))).toBe(true);
    expect(acknowledgeUpdateOutcomeNotice(store, scope, last.id)).toBe(true);
    const afterRelaunch = read(store);
    expect(afterRelaunch.lastCompleted).toEqual(last);
    expect(afterRelaunch.pendingNoticeId).toBeNull();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000 + 25 * 60 * 60 * 1000);
    try {
      expect(readUpdateOutcomeHistory({ ...store }, scope)).toEqual({ status: "ready", value: afterRelaunch });
      expect(acknowledgeUpdateOutcomeNotice(store, scope, last.id)).toBe(false);
    } finally {
      clock.mockRestore();
    }
    expect(last.rows.map((row) => [row.machineLabel, row.status])).toEqual([
      ["updated", "updated"], ["failed", "failed"], ["interrupted", "interrupted"],
      ["ready", "updated"], ["offline", "skipped"],
    ]);
    const bytes = [...store.values.values()].join("");
    expect(bytes).not.toContain("secret");
    expect(bytes).not.toContain("raw stderr");
    expect(last.rows[0]?.instanceId).toBe("codex-updated");
    expect(afterRelaunch.lastCompleted?.rows.map((row) => [row.targetVersion, row.observedVersion])).toEqual([
      ["2.0", "2.0"], [null, null], [null, null], ["3.0", "2.9"], [null, null],
    ]);
  });

  it("keeps previous completed data inside pending install and only finalizes observed versions", () => {
    const store = makeStore();
    const prior = completed();
    expect(writeUpdateOutcomeHistory(store, scope, (old) => completeUpdateOutcome(old, prior))).toBe(true);
    expect(writeUpdateOutcomeHistory(store, scope, (old) => reservePendingUpdateOutcome(old, pending()))).toBe(true);
    const staged = read(store);
    expect(staged.lastCompleted).toEqual(prior);
    const remoteOnly = completeUpdateOutcome(staged, completed("remote-completed"));
    expect(remoteOnly?.lastCompleted?.id).toBe("remote-completed");
    expect(remoteOnly?.pendingInstall).toEqual(staged.pendingInstall);
    expect(resolvePendingUpdateOutcome(staged, { currentVersion: "1.2.3" }, 3_000)).toBeNull();
    const applied = resolvePendingUpdateOutcome(staged, { currentVersion: "1.2.4" }, 3_000);
    expect(applied?.lastCompleted).toMatchObject({ id: "install-1", targetVersion: "1.2.4", completedAt: 3_000 });
    expect(applied?.lastCompleted?.rows.at(-1)?.status).toBe("updated");
    const failed = resolvePendingUpdateOutcome(staged, { currentVersion: "1.2.3", notAppliedVersion: "1.2.4" }, 3_000);
    expect(failed?.lastCompleted?.rows.at(-1)?.reason).toBe("install-not-applied");
    const asyncFailure = resolvePendingUpdateOutcome(staged, {
      currentVersion: "1.2.3", status: "error", errorContext: "install", downloadedVersion: "1.2.4",
    }, 3_000);
    expect(asyncFailure).toBeNull();
    expect(resolvePendingUpdateOutcome(staged, {
      currentVersion: "1.2.3", status: "error", errorContext: "install", downloadedVersion: "different",
    }, 3_000)).toBeNull();
    const staleFlag = { ...staged, pendingInstall: { ...staged.pendingInstall!, previousNotAppliedVersion: "1.2.4" } };
    expect(resolvePendingUpdateOutcome(staleFlag, { currentVersion: "1.2.3", notAppliedVersion: "1.2.4" }, 3_000)).toBeNull();
    const unrelated = resolvePendingUpdateOutcome(staged, { currentVersion: "1.2.5" }, 3_000);
    expect(unrelated).toBeNull();
    expect(read(store)).toEqual(staged);
    expect(staged.lastCompleted).toEqual(prior);
    expect(staged.pendingInstall?.previousCompletedId).toBe(prior.id);
  });

  it("rejects queued old observations and indistinguishable install errors on a same-target retry", () => {
    const store = makeStore();
    const empty = read(store);
    const first = reservePendingUpdateOutcome(empty, pending())!;
    const queuedId = first.pendingInstall!.id;
    const retry = reservePendingUpdateOutcome(empty, { ...pending(), id: "retry-2" })!;
    const staleError = { currentVersion: "1.2.3", status: "error", errorContext: "install",
      downloadedVersion: "1.2.4", notAppliedVersion: "1.2.4" };
    expect(resolvePendingUpdateOutcome(retry, staleError, 4_000, queuedId)).toBeNull();
    expect(resolvePendingUpdateOutcome(retry, staleError, 4_000, "retry-2")).toBeNull();
    // Even an exact version observation captured for A cannot retire retry B.
    expect(resolvePendingUpdateOutcome(retry, { currentVersion: "1.2.4" }, 4_000, queuedId)).toBeNull();
    expect(retry.pendingInstall?.id).toBe("retry-2");
    expect(retry.lastCompleted).toBeNull();
  });

  it("retires verified pending A without replacing later completed B or its notice", () => {
    const store = makeStore();
    const staged = reservePendingUpdateOutcome(read(store), pending())!;
    const b = completed("independent-B");
    for (const acknowledged of [false, true]) {
      const newer = completeUpdateOutcome(staged, b)!;
      const before = { ...newer, pendingNoticeId: acknowledged ? null : b.id };
      const resolved = resolvePendingUpdateOutcome(before, { currentVersion: "1.2.4" }, 5_000, "install-1");
      expect(resolved).toEqual({ ...before, pendingInstall: null });
      expect(writeUpdateOutcomeHistory(store, scope, () => resolved)).toBe(true);
      expect(read(store).lastCompleted).toEqual(b);
      expect(read(store).pendingNoticeId).toBe(before.pendingNoticeId);
    }
  });

  it("reserves the final client machine and row before calling the installer", async () => {
    let installs = 0;
    const row = completed().rows[0]!;
    const cases = [
      Array.from({ length: 512 }, () => ({ ...row, environmentId: "remote" })),
      Array.from({ length: 128 }, (_, i) => ({ ...row, environmentId: `remote-${i}` })),
    ];
    for (const rows of cases) {
      const store = makeStore();
      expect(await installAfterUpdateEverything({
        result: { localVersion: "1.2.4", updatedServers: rows.length, updatedProviders: 0, failures: [] },
        localReady: true,
        save: () => writeUpdateOutcomeHistory(store, scope, (old) => reservePendingUpdateOutcome(old, { ...pending(), rows })),
        install: async () => { installs += 1; return true; },
        clear: () => { throw new Error("No failed save may clear history"); },
      })).toBe("storage-failed");
      expect(store.values.size).toBe(0);
    }
    expect(installs).toBe(0);
    const store = makeStore();
    const rows = Array.from({ length: 127 }, (_, i) => ({ ...row, environmentId: `remote-${i}` }));
    const reserved = reservePendingUpdateOutcome(read(store), { ...pending(), rows });
    expect(reserved).not.toBeNull();
    const resolved = resolvePendingUpdateOutcome(reserved!, { currentVersion: "1.2.4" }, 5_000);
    expect(new Set(resolved!.lastCompleted!.rows.map((item) => item.environmentId)).size).toBe(128);
    expect(writeUpdateOutcomeHistory(store, scope, () => resolved)).toBe(true);
  });

  it("rejects a staged UTF8 envelope that fits but cannot fit its exact terminal version metadata", async () => {
    const store = makeStore();
    const empty = read(store);
    const row = completed().rows[0]!;
    // Find the first real UTF8 boundary deterministically; no timing or mocked capacity check.
    let input: PendingUpdateInstall | null = null;
    for (let count = 1; count <= 128; count += 1) {
      const candidate = { ...pending(), fromVersion: "旧".repeat(256), targetVersion: "新".repeat(256),
        rows: Array.from({ length: count }, () => ({ ...row, machineLabel: "猫".repeat(128) })) };
      const staged = { ...empty, pendingInstall: candidate };
      const bytes = new TextEncoder().encode(JSON.stringify(staged)).length;
      if (bytes <= 65_536 && reservePendingUpdateOutcome(empty, candidate) === null) {
        input = candidate; break;
      }
    }
    expect(input).not.toBeNull();
    let installs = 0;
    expect(await installAfterUpdateEverything({
      result: { localVersion: input!.targetVersion, updatedServers: 1, updatedProviders: 0, failures: [] },
      localReady: true,
      save: () => writeUpdateOutcomeHistory(store, scope, (old) => reservePendingUpdateOutcome(old, input!)),
      install: async () => { installs += 1; return true; },
      clear: () => { throw new Error("No destructive clear"); },
    })).toBe("storage-failed");
    expect(installs).toBe(0);
    expect(store.values.size).toBe(0);
  });

  it("never replays an install when reading, acknowledging or clearing the completed result", async () => {
    const store = makeStore();
    let installs = 0;
    expect(await installAfterUpdateEverything({
      result: { localVersion: "1.2.4", updatedServers: 1, updatedProviders: 0, failures: [] },
      localReady: true,
      save: () => writeUpdateOutcomeHistory(store, scope, (old) => reservePendingUpdateOutcome(old, pending())),
      install: async () => { installs += 1; return true; },
      clear: () => { throw new Error("Accepted install must retain its pending handoff"); },
    })).toBe("relaunching");
    expect(writeUpdateOutcomeHistory(store, scope, (old) =>
      resolvePendingUpdateOutcome(old, { currentVersion: "1.2.4" }, 3_000),
    )).toBe(true);
    expect(acknowledgeUpdateOutcomeNotice(store, scope, "install-1")).toBe(true);
    expect(read(store).lastCompleted?.id).toBe("install-1");
    expect(readUpdateOutcomeHistory({ ...store }, scope).status).toBe("ready");
    expect(clearUpdateOutcomeHistory(store, scope)).toBe(true);
    expect(read(store).lastCompleted).toBeNull();
    expect(installs).toBe(1);
  });

  it("isolates profiles/environments/surfaces and explicitly clears only the selected scope", () => {
    const first = makeStore();
    const otherProfile = makeStore();
    const otherScope = { ...scope, primaryEnvironmentId: "primary-B" };
    const webScope = { ...scope, surface: "web" as const };
    for (const selected of [scope, otherScope, webScope]) {
      expect(writeUpdateOutcomeHistory(first, selected, (old) => completeUpdateOutcome(old, completed()))).toBe(true);
    }
    expect(readUpdateOutcomeHistory(otherProfile, scope)).toMatchObject({ status: "ready", value: { lastCompleted: null } });
    expect(clearUpdateOutcomeHistory(first, scope)).toBe(true);
    expect(read(first).lastCompleted).toBeNull();
    expect(readUpdateOutcomeHistory(first, otherScope)).toMatchObject({ status: "ready", value: { lastCompleted: completed() } });
    expect(readUpdateOutcomeHistory(first, webScope)).toMatchObject({ status: "ready", value: { lastCompleted: completed() } });
    expect(updateOutcomeScope("desktop", null)).toBeNull();
    expect(writeUpdateOutcomeHistory(first, null, (old) => old)).toBe(false);
    expect(readUpdateOutcomeHistory(first, null).status).toBe("unavailable");
  });

  it("rejects malformed, oversized, foreign-version and wrong-scope records without destructive reads", () => {
    const store = makeStore();
    expect(writeUpdateOutcomeHistory(store, scope, (old) => completeUpdateOutcome(old, completed()))).toBe(true);
    const key = [...store.values.keys()][0]!;
    const original = read(store);
    for (const raw of [
      "not JSON", "x".repeat(65_537),
      JSON.stringify({ ...original, schemaVersion: 3 }),
      JSON.stringify({ ...original, scope: { ...scope, primaryEnvironmentId: "different" } }),
      JSON.stringify({ ...original, lastCompleted: { ...completed(), completedAt: -1 } }),
    ]) {
      store.values.set(key, raw);
      expect(readUpdateOutcomeHistory(store, scope).status).toBe("unavailable");
      expect(store.values.get(key)).toBe(raw);
      expect(store.removes()).toBe(0);
    }
  });

  it("caps UTF8 payload, machine count and row count without truncating or deleting the last result", () => {
    const store = makeStore();
    expect(writeUpdateOutcomeHistory(store, scope, (old) => completeUpdateOutcome(old, completed()))).toBe(true);
    const original = [...store.values.values()][0];
    const row = completed().rows[0]!;
    const cases = [
      Array.from({ length: 129 }, (_, i) => ({ ...row, environmentId: `env-${i}` })),
      Array.from({ length: 513 }, () => row),
      [{ ...row, targetVersion: "x".repeat(257) }],
      [{ ...row, observedVersion: "x".repeat(257) }],
      Array.from({ length: 128 }, () => ({ ...row, machineLabel: "猫".repeat(256) })),
    ];
    for (const rows of cases) {
      expect(writeUpdateOutcomeHistory(store, scope, (old) => completeUpdateOutcome(old, { ...completed(), rows }))).toBe(false);
      expect([...store.values.values()][0]).toBe(original);
      expect(store.removes()).toBe(0);
    }
  });

  it("keeps local install at zero on quota/readback failure and never removes prior data", async () => {
    const store = makeStore();
    expect(writeUpdateOutcomeHistory(store, scope, (old) => completeUpdateOutcome(old, completed()))).toBe(true);
    let installs = 0;
    const quota = { ...store, setItem: () => { throw new Error("quota"); } };
    let written = false;
    const brokenReadback = { ...store,
      setItem: (key: string, raw: string) => { store.setItem(key, raw); written = true; },
      getItem: (key: string) => written ? "corrupt" : store.getItem(key),
    };
    for (const storage of [quota, brokenReadback]) {
      expect(await installAfterUpdateEverything({
        result: { localVersion: "1.2.4", updatedServers: 1, updatedProviders: 0, failures: [] },
        localReady: true,
        save: () => writeUpdateOutcomeHistory(storage, scope, (old) => reservePendingUpdateOutcome(old, pending())),
        install: async () => { installs += 1; return true; },
        clear: () => { throw new Error("Failed saves must not clear old history"); },
      })).toBe("storage-failed");
    }
    expect(installs).toBe(0);
    expect(store.removes()).toBe(0);
    // The provisional bytes include prior data; the failed readback is still unavailable.
    expect(JSON.parse([...store.values.values()][0]!).lastCompleted).toEqual(completed());
    expect(readUpdateOutcomeHistory(brokenReadback, scope).status).toBe("unavailable");
  });
});
