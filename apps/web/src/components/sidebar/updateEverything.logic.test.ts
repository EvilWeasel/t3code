import { EnvironmentId, type ServerSelfUpdateCapability } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

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
      { status: "interrupted" },
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
      skipped: ["busy: Update was not started."],
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
      ].join("\n"),
    });
    expect(getUpdateEverythingToastView({ ...result, failures: [] }, "0.0.40")).toEqual({
      type: "success",
      title: "Updated 2 servers and 1 provider",
      description: "Skipped busy: Update was not started.",
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
