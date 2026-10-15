import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "~/versionSkew";
import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";
import type { ProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";

export interface UpdateEverythingMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: {
    readonly environment: ServerConfig["environment"];
    readonly settings: Pick<ServerConfig["settings"], "continueThreadsAfterServerUpdate">;
  } | null;
  readonly connected: boolean;
  /** Served by the desktop app this client runs in (the primary backend or a
      local WSL backend). Its server updates when the app installs. */
  readonly hostedByThisApp: boolean;
  /** The session holds the scope a server update needs. */
  readonly canMaintain: boolean;
  readonly updateState: ServerUpdateState;
}

/** A server that restarts during a run. */
export interface RestartingMachine {
  readonly environmentId: EnvironmentId;
  /** The server resumes interrupted threads after it restarts. */
  readonly continuesThreads: boolean;
}

/**
 * The servers a run restarts: each server it updates, and the servers this app
 * hosts when this app installs. Provider updates restart nothing.
 */
export function collectRestartingMachines(
  machines: ReadonlyArray<UpdateEverythingMachine>,
  servers: ReadonlyArray<Pick<ServerUpdateTarget, "environmentId">>,
  installsLocal: boolean,
): RestartingMachine[] {
  const updated = new Set(servers.map((server) => server.environmentId));
  return machines.flatMap((machine) => {
    const config = machine.serverConfig;
    if (
      config === null ||
      !machine.connected ||
      !(updated.has(machine.environmentId) || (installsLocal && machine.hostedByThisApp))
    ) {
      return [];
    }
    return [
      {
        environmentId: machine.environmentId,
        continuesThreads:
          config.environment.capabilities.threadRestartContinuation === true &&
          config.settings.continueThreadsAfterServerUpdate === true,
      },
    ];
  });
}

/** A machine the run leaves alone, with a short reason such as "not connected". */
export interface SkippedMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reason: string;
}

/**
 * The servers that "update everything" moves to `targetVersion`: connected,
 * permitted, able to update over RPC, behind the target, and on its release
 * channel. Every other behind server comes back in `skipped` with a reason for
 * the confirmation; a machine that never connected has an unknown version, so
 * it counts as skipped. Two kinds are in neither list: servers already on the
 * target, and servers this app hosts, which would relaunch the app mid-run
 * and update with the app's own install anyway. A desktop-managed server
 * follows its own app's update feed, so the channel rule does not apply to it.
 */
export function collectServerUpdateTargets(
  machines: ReadonlyArray<UpdateEverythingMachine>,
  targetVersion: string,
): { readonly targets: ServerUpdateTarget[]; readonly skipped: SkippedMachine[] } {
  const targets: ServerUpdateTarget[] = [];
  const skipped: SkippedMachine[] = [];
  for (const machine of machines) {
    const config = machine.serverConfig;
    if (machine.hostedByThisApp) continue;
    if (
      config !== null &&
      resolveVersionMismatch(config.environment.serverVersion, targetVersion) === null
    ) {
      continue;
    }
    const skip = (reason: string) =>
      skipped.push({ environmentId: machine.environmentId, label: machine.label, reason });
    if (config === null || !machine.connected) {
      skip("not connected");
      continue;
    }
    if (!machine.canMaintain) {
      skip("no permission");
      continue;
    }
    if (machine.updateState.status === "running") {
      skip("already updating");
      continue;
    }
    const selfUpdate = resolveServerSelfUpdateCapability(config);
    const desktopAppUpdate = supportsDesktopAppUpdate(config);
    if (selfUpdate === null) {
      skip("needs a manual update");
      continue;
    }
    if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
      skip("needs a newer desktop app");
      continue;
    }
    const serverVersion = config.environment.serverVersion;
    if (
      selfUpdate !== "desktop-managed" &&
      cliReleaseChannelOf(serverVersion) !== cliReleaseChannelOf(targetVersion)
    ) {
      skip(`on the ${cliReleaseChannelOf(serverVersion)} channel`);
      continue;
    }
    targets.push({
      environmentId: machine.environmentId,
      serverLabel: machine.label,
      selfUpdate,
      installation: config.environment.capabilities.serverInstallation,
      desktopAppUpdate,
      threadContinuation: supportsServerUpdateThreadContinuation(config),
      continueThreadsAfterServerUpdate: config.settings.continueThreadsAfterServerUpdate ?? false,
      targetVersion,
    });
  }
  return { targets, skipped };
}

export interface UpdateEverythingSteps<Providers, Servers> {
  /** Downloads this app's update. Resolves true when it is ready to install.
      Without it, `localReady` is true: there is nothing to download. */
  readonly downloadLocal?: () => Promise<boolean>;
  readonly updateProviders: () => Promise<Providers>;
  readonly updateServers: () => Promise<Servers>;
}

/**
 * Runs the remote half of one "update everything" pass and returns each
 * step's results. Providers finish before any server restarts, so no install
 * is cut off. The local download runs alongside the remote work. The caller
 * installs this app afterwards when `localReady`, because the relaunch ends
 * the run; a failed download skips only that install.
 */
export async function runUpdateEverything<Providers, Servers>(
  steps: UpdateEverythingSteps<Providers, Servers>,
): Promise<{
  readonly localReady: boolean;
  readonly providers: Providers;
  readonly servers: Servers;
}> {
  const [localReady, remote] = await Promise.all([
    steps.downloadLocal?.() ?? Promise.resolve(true),
    steps
      .updateProviders()
      .then(async (providers) => ({ providers, servers: await steps.updateServers() })),
  ]);
  return { localReady, ...remote };
}

/** The current state of one machine in a running pass. */
export type UpdateRunMachineStatus =
  | "providers"
  | "waiting"
  | "downloading"
  | "restarting"
  | "done"
  | "skipped"
  | "failed";

/** One machine in a running "update everything" pass. */
export interface UpdateRunMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly updatesProviders: boolean;
  readonly updatesServer: boolean;
  /** Set when every update for this machine has finished. */
  readonly result: "done" | "failed" | "skipped" | null;
}

/** A running "update everything" pass, kept while it runs. */
export interface UpdateEverythingRun {
  /** The version this app installs last, or null when it does not install. */
  readonly localVersion: string | null;
  /** Providers update first. Servers update after every provider finished. */
  readonly phase: "providers" | "servers" | "installing";
  readonly machines: ReadonlyArray<UpdateRunMachine>;
}

/** Status of one machine, from the run and that server's own update state. */
export function resolveUpdateRunMachineStatus(
  machine: UpdateRunMachine,
  phase: UpdateEverythingRun["phase"],
  serverState: ServerUpdateState,
): UpdateRunMachineStatus {
  if (machine.result !== null) return machine.result;
  if (phase === "providers" && machine.updatesProviders) return "providers";
  if (machine.updatesServer && serverState.status === "running") {
    return serverState.stage === "resuming" ? "restarting" : "downloading";
  }
  return "waiting";
}

const RUN_STATUS_LABELS: Record<UpdateRunMachineStatus, string> = {
  providers: "updating providers",
  waiting: "waiting",
  downloading: "downloading",
  restarting: "restarting",
  done: "done",
  skipped: "skipped",
  failed: "failed",
};

/**
 * Tooltip lines for a running pass, such as "alvin: restarting". `local` is
 * this app's own state, such as "downloading 40%", or null when it does not
 * install.
 */
export function describeUpdateRun(
  machines: ReadonlyArray<{ readonly label: string; readonly status: UpdateRunMachineStatus }>,
  local: string | null,
): ReadonlyArray<string> {
  return [
    "Updating…",
    ...(local === null ? [] : [`This app: ${local}`]),
    ...machines.map((machine) => `${machine.label}: ${RUN_STATUS_LABELS[machine.status]}`),
  ];
}

/** What one pass did. It is saved before this app installs, so it outlives the relaunch. */
export interface UpdateEverythingResult {
  /** The version this app installed last, or null when it did not install. */
  readonly localVersion: string | null;
  readonly updatedServers: number;
  readonly updatedProviders: number;
  /** One line per failure, each naming its machine. */
  readonly failures: ReadonlyArray<string>;
  readonly skipped?: ReadonlyArray<string>;
}

const SAVED_RESULT_KEY = "t3code:update-everything-result:v1";
const SAVED_RESULT_MAX_AGE_MS = 10 * 60 * 1000;
const SavedResult = Schema.fromJsonString(
  Schema.Struct({
    savedAt: Schema.Number,
    localVersion: Schema.NullOr(Schema.String),
    updatedServers: Schema.Number,
    updatedProviders: Schema.Number,
    failures: Schema.Array(Schema.String),
    skipped: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const decodeSavedResult = Schema.decodeUnknownOption(SavedResult);
type ResultStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Verify that the summary survived storage before its owner quits. */
export function persistUpdateEverythingResult(
  result: UpdateEverythingResult,
  storage: ResultStorage,
  now: number,
): boolean {
  try {
    const raw = JSON.stringify({ ...result, savedAt: now });
    storage.setItem(SAVED_RESULT_KEY, raw);
    if (storage.getItem(SAVED_RESULT_KEY) === raw) return true;
  } catch {
    // A failed write must not leave an older pass looking like this install.
  }
  try {
    storage.removeItem(SAVED_RESULT_KEY);
  } catch {
    // Storage is unavailable.
  }
  return false;
}

export function clearUpdateEverythingResult(storage: ResultStorage): void {
  storage.removeItem(SAVED_RESULT_KEY);
}

/** Consume a validated summary once after relaunch, without replaying updates. */
export function takeUpdateEverythingResult(
  storage: ResultStorage,
  now: number,
): UpdateEverythingResult | null {
  try {
    const raw = storage.getItem(SAVED_RESULT_KEY);
    if (raw === null) return null;
    const saved = decodeSavedResult(raw);
    storage.removeItem(SAVED_RESULT_KEY);
    return Option.getOrNull(
      Option.filter(saved, (value) =>
        now >= value.savedAt && now - value.savedAt < SAVED_RESULT_MAX_AGE_MS,
      ),
    );
  } catch {
    return null;
  }
}

/** The local handoff runs after every remote result has settled. */
export async function installAfterUpdateEverything(input: {
  readonly result: UpdateEverythingResult;
  readonly localReady: boolean;
  readonly install: () => Promise<boolean>;
  readonly save: (result: UpdateEverythingResult) => boolean;
  readonly clear: () => void;
}): Promise<"relaunching" | "not-installed" | "storage-failed"> {
  if (!input.localReady) return "not-installed";
  if (!input.save(input.result)) return "storage-failed";
  let relaunching = false;
  try {
    relaunching = await input.install();
    return relaunching ? "relaunching" : "not-installed";
  } finally {
    if (!relaunching) input.clear();
  }
}

/** Counts what a pass updated and lists each failure with its machine. */
export function collectUpdateEverythingResult(input: {
  readonly localVersion: string | null;
  /** This app's own download or install failures. */
  readonly localFailures: ReadonlyArray<string>;
  readonly skipped?: ReadonlyArray<SkippedMachine>;
  readonly servers: ReadonlyArray<{
    readonly label: string;
    readonly outcome: ServerUpdateOutcome;
  }>;
  readonly providers: ReadonlyArray<ProviderUpdateRunOutcome>;
}): UpdateEverythingResult {
  const skipped = [
    ...(input.skipped ?? []).map((machine) => `${machine.label}: ${machine.reason}`),
    ...input.servers.flatMap(({ label, outcome }) => outcome.status === "skipped"
      ? [`${label}: ${outcome.message ?? "Update was not started."}`] : []),
    ...input.providers.flatMap((outcome) => outcome.status === "interrupted" ? [outcome.line] : []),
  ];
  return {
    localVersion: input.localVersion,
    updatedServers: input.servers.filter(({ outcome }) => outcome.status === "updated").length,
    updatedProviders: input.providers.filter((outcome) => outcome.status === "updated").length,
    failures: [
      ...input.localFailures.map((failure) => `This app: ${failure}`),
      ...input.servers.flatMap(({ label, outcome }) =>
        outcome.status === "failed" ? [`${label}: ${outcome.message}`] : [],
      ),
      ...input.providers.flatMap((outcome) => (outcome.status === "failed" ? [outcome.line] : [])),
    ],
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

/**
 * The one toast for a finished pass, such as "Updated this app, 8 servers,
 * and 3 providers" with a line per failure. `appVersion` is the version this
 * app runs now: after the relaunch it tells whether the local install
 * applied. Interrupted providers remain visible as skipped outcomes; null
 * means the pass had no updates, failures, or skipped outcomes to report.
 */
export function getUpdateEverythingToastView(
  result: UpdateEverythingResult,
  appVersion: string,
): {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description?: string;
} | null {
  const parts = [
    result.localVersion !== null && result.localVersion === appVersion ? "this app" : null,
    countLabel(result.updatedServers, "server"),
    countLabel(result.updatedProviders, "provider"),
  ].filter((part) => part !== null);
  const description = [
    ...result.failures,
    ...(result.skipped ?? []).map((line) => `Skipped ${line}`),
  ].join("\n");
  if (result.failures.length === 0 && !result.skipped?.length) {
    return parts.length === 0 ? null : { type: "success", title: `Updated ${joinList(parts)}` };
  }
  return {
    type: result.failures.length > 0 || parts.length === 0 ? "error" : "success",
    title:
      parts.length === 0
        ? result.failures.length > 0 ? "Update failed" : "Updates skipped"
        : `Updated ${joinList(parts)}`,
    description,
  };
}

export interface UpdateEverythingPlan {
  /** The version this desktop app installs, or null when it is not updating. */
  readonly localVersion: string | null;
  readonly servers: ReadonlyArray<
    Pick<ServerUpdateTarget, "environmentId" | "serverLabel" | "selfUpdate" | "targetVersion">
  >;
  readonly providerMachines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    /** Display names of the outdated providers on that machine. */
    readonly providers: ReadonlyArray<string>;
  }>;
}

function countLabel(count: number, noun: string): string | null {
  return count === 0 ? null : `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function joinList(parts: ReadonlyArray<string>): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/**
 * Text for the sidebar tooltip and the confirmation. `summary` reads like
 * "Update this app, 2 servers, and 3 providers". `lines` has one entry per
 * machine, this app first, such as "alvin: server to 0.0.50, Codex, Claude".
 */
export function describeUpdateEverything(plan: UpdateEverythingPlan): {
  readonly summary: string;
  readonly lines: ReadonlyArray<string>;
} {
  const providerCount = plan.providerMachines.reduce(
    (count, machine) => count + machine.providers.length,
    0,
  );
  const summary = `Update ${joinList(
    [
      plan.localVersion ? "this app" : null,
      countLabel(plan.servers.length, "server"),
      countLabel(providerCount, "provider"),
    ].filter((part) => part !== null),
  )}`;

  const machines = new Map<EnvironmentId, { label: string; items: string[] }>();
  const itemsFor = (environmentId: EnvironmentId, label: string) => {
    const existing = machines.get(environmentId);
    if (existing) return existing.items;
    const items: string[] = [];
    machines.set(environmentId, { label, items });
    return items;
  };
  for (const server of plan.servers) {
    // A desktop-managed server installs whatever its own app's update feed
    // offers, so it has no target version to show.
    itemsFor(server.environmentId, server.serverLabel).push(
      server.selfUpdate === "desktop-managed"
        ? "desktop app update"
        : `server to ${server.targetVersion}`,
    );
  }
  for (const machine of plan.providerMachines) {
    itemsFor(machine.environmentId, machine.label).push(...machine.providers);
  }

  return {
    summary,
    lines: [
      ...(plan.localVersion ? [`This app: ${plan.localVersion}, restarts last`] : []),
      ...Array.from(machines.values(), ({ label, items }) => `${label}: ${items.join(", ")}`),
    ],
  };
}

// Last completed result metadata is separate from the legacy, short-lived toast handoff.
const HistoryText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256));
const HistoryTime = Schema.Number.check(
  Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const HistoryScope = Schema.Struct({
  surface: Schema.Literals(["desktop", "web"]),
  primaryEnvironmentId: HistoryText,
});
const HistoryRow = Schema.Struct({
  environmentId: HistoryText,
  machineLabel: HistoryText,
  component: Schema.Literals(["server", "provider", "client"]),
  driver: Schema.NullOr(HistoryText),
  instanceId: Schema.NullOr(HistoryText),
  status: Schema.Literals(["updated", "failed", "interrupted", "skipped"]),
  reason: Schema.Literals([
    "none", "update-failed", "interrupted", "not-connected", "not-started", "download-failed",
    "install-failed", "install-not-applied", "unverified-install", "different-channel",
    "no-permission", "already-updating", "manual-update",
  ]),
  targetVersion: Schema.NullOr(HistoryText),
  observedVersion: Schema.NullOr(HistoryText),
});
const HistoryRows = Schema.Array(HistoryRow).check(Schema.isMaxLength(512));
const CompletedUpdate = Schema.Struct({
  id: HistoryText,
  completedAt: HistoryTime,
  clientVersion: HistoryText,
  targetVersion: Schema.NullOr(HistoryText),
  rows: HistoryRows,
});
const PendingInstall = Schema.Struct({
  id: HistoryText,
  startedAt: HistoryTime,
  fromVersion: HistoryText,
  targetVersion: HistoryText,
  previousNotAppliedVersion: Schema.NullOr(HistoryText),
  previousCompletedId: Schema.NullOr(HistoryText),
  rows: HistoryRows,
});
const UpdateHistory = Schema.Struct({
  schemaVersion: Schema.Literals([2]),
  scope: HistoryScope,
  lastCompleted: Schema.NullOr(CompletedUpdate),
  pendingInstall: Schema.NullOr(PendingInstall),
  pendingNoticeId: Schema.NullOr(HistoryText),
});
export type UpdateOutcomeScope = typeof HistoryScope.Type;
export type LastUpdateRow = typeof HistoryRow.Type;
export type LastCompletedUpdate = typeof CompletedUpdate.Type;
export type PendingUpdateInstall = typeof PendingInstall.Type;
export type UpdateOutcomeHistory = typeof UpdateHistory.Type;
export type UpdateHistoryRead =
  | { readonly status: "ready"; readonly value: UpdateOutcomeHistory }
  | { readonly status: "unavailable" };
const decodeHistory = Schema.decodeUnknownOption(UpdateHistory);
const HISTORY_MAX_BYTES = 65_536;

export function updateOutcomeScope(
  surface: "desktop" | "web", primaryEnvironmentId: string | null,
): UpdateOutcomeScope | null {
  return primaryEnvironmentId && primaryEnvironmentId.length <= 256
    ? { surface, primaryEnvironmentId } : null;
}

function historyKey(scope: UpdateOutcomeScope): string {
  return `t3code:update-everything:last-outcome:v2:${scope.surface}:${encodeURIComponent(scope.primaryEnvironmentId)}`;
}

function validateHistory(value: unknown, scope: UpdateOutcomeScope): UpdateOutcomeHistory | null {
  const decoded = decodeHistory(value);
  if (Option.isNone(decoded)) return null;
  const history = decoded.value;
  if (history.scope.surface !== scope.surface ||
      history.scope.primaryEnvironmentId !== scope.primaryEnvironmentId) return null;
  const rows = [...(history.lastCompleted?.rows ?? []), ...(history.pendingInstall?.rows ?? [])];
  if (rows.length > 512 || new Set(rows.map((row) => row.environmentId)).size > 128) return null;
  if (rows.some((row) => row.component === "provider"
    ? row.driver === null || row.instanceId === null
    : row.driver !== null || row.instanceId !== null)) return null;
  if (history.pendingInstall && (history.pendingInstall.fromVersion === history.pendingInstall.targetVersion ||
      history.pendingInstall.rows.some((row) => row.component === "client"))) return null;
  if (history.pendingNoticeId !== null && history.pendingNoticeId !== history.lastCompleted?.id) return null;
  return history;
}

/** Corrupt/foreign/oversized records are unavailable, never destructively consumed. */
export function readUpdateOutcomeHistory(
  storage: ResultStorage, scope: UpdateOutcomeScope | null,
): UpdateHistoryRead {
  if (scope === null) return { status: "unavailable" };
  try {
    const raw = storage.getItem(historyKey(scope));
    if (raw === null) return { status: "ready", value: {
      schemaVersion: 2, scope, lastCompleted: null, pendingInstall: null, pendingNoticeId: null,
    } };
    if (raw.length > HISTORY_MAX_BYTES || new TextEncoder().encode(raw).length > HISTORY_MAX_BYTES) {
      return { status: "unavailable" };
    }
    const history = validateHistory(JSON.parse(raw), scope);
    return history ? { status: "ready", value: history } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/** One bounded envelope write. Readback failure is unknown durability, not success. */
export function writeUpdateOutcomeHistory(
  storage: ResultStorage, scope: UpdateOutcomeScope | null,
  change: (previous: UpdateOutcomeHistory) => UpdateOutcomeHistory | null,
): boolean {
  if (scope === null) return false;
  const previous = readUpdateOutcomeHistory(storage, scope);
  if (previous.status !== "ready") return false;
  try {
    const next = validateHistory(change(previous.value), scope);
    if (next === null) return false;
    // Decode before encoding: only allowlisted metadata enters storage, never raw errors.
    const raw = JSON.stringify(next);
    if (new TextEncoder().encode(raw).length > HISTORY_MAX_BYTES) return false;
    storage.setItem(historyKey(scope), raw);
    return storage.getItem(historyKey(scope)) === raw;
  } catch {
    // Do not remove a valid prior result on a failed save.
    return false;
  }
}

export function completeUpdateOutcome(
  previous: UpdateOutcomeHistory, completed: LastCompletedUpdate, pendingId?: string,
): UpdateOutcomeHistory | null {
  if (pendingId !== undefined && previous.pendingInstall?.id !== pendingId) return null;
  if (pendingId !== undefined && previous.pendingInstall?.previousCompletedId !==
      (previous.lastCompleted?.id ?? null)) {
    // A later independent completion owns LAST and its notice. Only retire the verified handoff.
    return { ...previous, pendingInstall: null };
  }
  return { ...previous, lastCompleted: completed,
    pendingInstall: pendingId === undefined ? previous.pendingInstall : null,
    pendingNoticeId: completed.id };
}

export function acknowledgeUpdateOutcomeNotice(
  storage: ResultStorage, scope: UpdateOutcomeScope | null, noticeId: string,
): boolean {
  return writeUpdateOutcomeHistory(storage, scope, (history) =>
    history.pendingNoticeId === noticeId ? { ...history, pendingNoticeId: null } : null,
  );
}

export function clearUpdateOutcomeHistory(storage: ResultStorage, scope: UpdateOutcomeScope | null): boolean {
  if (scope === null) return false;
  try {
    storage.removeItem(historyKey(scope));
    return storage.getItem(historyKey(scope)) === null;
  } catch {
    return false;
  }
}

export function localUpdateOutcomeRow(
  scope: UpdateOutcomeScope, status: LastUpdateRow["status"], reason: LastUpdateRow["reason"],
  targetVersion: string | null = null, observedVersion: string | null = null,
): LastUpdateRow {
  return { environmentId: scope.primaryEnvironmentId, machineLabel: "This app", component: "client",
    driver: null, instanceId: null, status, reason, targetVersion, observedVersion };
}

/** Validate the actual handoff AND its mandatory terminal client row before installation. */
export function reservePendingUpdateOutcome(
  previous: UpdateOutcomeHistory,
  input: Omit<PendingUpdateInstall, "previousCompletedId">,
): UpdateOutcomeHistory | null {
  const pending = { ...input, previousCompletedId: previous.lastCompleted?.id ?? null };
  const staged = { ...previous, pendingInstall: pending };
  const fits = (value: UpdateOutcomeHistory | null) => {
    const checked = validateHistory(value, previous.scope);
    return checked !== null && new TextEncoder().encode(JSON.stringify(checked)).length <= HISTORY_MAX_BYTES;
  };
  if (!fits(staged)) return null;
  // Reserve the longest terminal metadata, including numeric timestamp width and exact version bytes.
  for (const observedVersion of [pending.fromVersion, pending.targetVersion]) {
    const terminal = completeUpdateOutcome(staged, {
      id: pending.id, completedAt: Number.MAX_SAFE_INTEGER,
      clientVersion: observedVersion, targetVersion: pending.targetVersion,
      rows: [...pending.rows, localUpdateOutcomeRow(previous.scope, "interrupted", "install-not-applied",
        pending.targetVersion, observedVersion)],
    }, pending.id);
    if (!fits(terminal)) return null;
  }
  return staged;
}

/** No raw command output or exception text is copied into durable rows. */
export function buildUpdateOutcomeRows(input: {
  readonly providers: ReadonlyArray<ProviderUpdateRunOutcome>;
  readonly servers: ReadonlyArray<{
    readonly environmentId: string; readonly label: string; readonly outcome: ServerUpdateOutcome;
    readonly targetVersion?: string | null; readonly observedVersion?: string | null;
  }>;
  readonly skipped: ReadonlyArray<SkippedMachine>;
}): ReadonlyArray<LastUpdateRow> | null {
  const rows: LastUpdateRow[] = [];
  for (const provider of input.providers) {
    if (!provider.identity) return null;
    rows.push({ ...provider.identity, component: "provider", status: provider.status,
      targetVersion: provider.targetVersion ?? null, observedVersion: provider.observedVersion ?? null,
      reason: provider.status === "updated" ? "none" : provider.status === "interrupted" ? "interrupted" : "update-failed" });
  }
  for (const server of input.servers) {
    const interrupted = server.outcome.status === "skipped" && server.outcome.message === "Update was interrupted.";
    rows.push({ environmentId: server.environmentId, machineLabel: server.label, component: "server",
      targetVersion: server.targetVersion ?? null, observedVersion: server.observedVersion ?? null,
      driver: null, instanceId: null, status: interrupted ? "interrupted" : server.outcome.status,
      reason: interrupted ? "interrupted" : server.outcome.status === "updated" ? "none"
        : server.outcome.status === "failed" ? "update-failed" : "not-started" });
  }
  for (const machine of input.skipped) {
    const reason = machine.reason === "not connected" ? "not-connected"
      : machine.reason === "no permission" ? "no-permission"
      : machine.reason === "already updating" ? "already-updating"
      : machine.reason.startsWith("on the ") ? "different-channel" : "manual-update";
    rows.push({ environmentId: machine.environmentId, machineLabel: machine.label, component: "server",
      driver: null, instanceId: null, status: "skipped", reason, targetVersion: null, observedVersion: null });
  }
  return rows;
}

/** Unknown same-version observations stay pending; they cannot prove an install failed. */
export function resolvePendingUpdateOutcome(
  history: UpdateOutcomeHistory,
  observation: {
    readonly currentVersion: string;
    readonly notAppliedVersion?: string;
    readonly status?: string;
    readonly errorContext?: string | null;
    readonly downloadedVersion?: string | null;
  },
  now: number,
  expectedPendingId = history.pendingInstall?.id,
): UpdateOutcomeHistory | null {
  const pending = history.pendingInstall;
  if (!pending || pending.id !== expectedPendingId) return null;
  if (observation.status === "error" && observation.errorContext === "install") return null;
  let status: LastUpdateRow["status"];
  let reason: LastUpdateRow["reason"];
  if (observation.currentVersion === pending.targetVersion) {
    status = "updated"; reason = "none";
  } else if (observation.currentVersion === pending.fromVersion &&
      observation.notAppliedVersion === pending.targetVersion &&
      pending.previousNotAppliedVersion !== pending.targetVersion) {
    status = "failed"; reason = "install-not-applied";
  } else {
    // Neither an unrelated version nor an install-error snapshot identifies this attempt.
    return null;
  }
  return completeUpdateOutcome(history, {
    id: pending.id, completedAt: now, clientVersion: observation.currentVersion,
    targetVersion: pending.targetVersion,
    rows: [...pending.rows, localUpdateOutcomeRow(history.scope, status, reason,
      pending.targetVersion, observation.currentVersion)],
  }, pending.id);
}
