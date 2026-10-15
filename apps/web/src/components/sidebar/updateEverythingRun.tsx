import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { APP_VERSION } from "~/branding";
import { isElectron } from "~/env";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  getUpdateEverythingToastView,
  takeUpdateEverythingResult,
  acknowledgeUpdateOutcomeNotice,
  clearUpdateOutcomeHistory,
  completeUpdateOutcome,
  readUpdateOutcomeHistory,
  resolvePendingUpdateOutcome,
  reservePendingUpdateOutcome,
  updateOutcomeScope,
  writeUpdateOutcomeHistory,
  type UpdateOutcomeScope,
  type UpdateOutcomeHistory,
  type UpdateHistoryRead,
  type LastCompletedUpdate,
  type PendingUpdateInstall,
  type UpdateEverythingResult,
  type UpdateEverythingRun,
} from "./updateEverything.logic";

/** The running "update everything" pass, or null. Outlives the sidebar button. */
const updateEverythingRunAtom = Atom.make<UpdateEverythingRun | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("update-everything-run"),
);

export function useUpdateEverythingRun(): UpdateEverythingRun | null {
  return useAtomValue(updateEverythingRunAtom);
}

/** Starts, changes, or ends (null) the running pass. */
export function setUpdateEverythingRun(
  update: (run: UpdateEverythingRun | null) => UpdateEverythingRun | null,
): void {
  appAtomRegistry.update(updateEverythingRunAtom, update);
}

/** Records the result of every update for one machine in the running pass. */
export function settleUpdateRunMachine(
  environmentId: EnvironmentId,
  result: "done" | "failed" | "skipped",
): void {
  setUpdateEverythingRun(
    (run) =>
      run && {
        ...run,
        machines: run.machines.map((machine) =>
          machine.environmentId === environmentId
            ? { ...machine, result }
            : machine,
        ),
      },
  );
}

function takeSavedUpdateEverythingResult(): UpdateEverythingResult | null {
  try {
    return takeUpdateEverythingResult(window.localStorage, Date.now());
  } catch {
    return null;
  }
}

/** Shows the one summary toast for a finished pass. */
export function showUpdateEverythingResult(result: UpdateEverythingResult): void {
  const view = getUpdateEverythingToastView(result, APP_VERSION);
  if (!view) return;
  toastManager.add(
    stackedThreadToast({
      type: view.type,
      title: view.title,
      ...(view.description
        ? { description: <span className="whitespace-pre-line">{view.description}</span> }
        : {}),
    }),
  );
}

const historyRevisionAtom = Atom.make(0).pipe(Atom.keepAlive);
const unavailableScopes = new Set<string>();
const liveInstallIds = new Set<string>();
const scopeId = (scope: UpdateOutcomeScope) => `${scope.surface}:${scope.primaryEnvironmentId}`;
const notifyHistoryChanged = () => appAtomRegistry.update(historyRevisionAtom, (value) => value + 1);

export function useUpdateOutcomeScope(): UpdateOutcomeScope | null {
  const primary = usePrimaryEnvironmentId();
  return useMemo(() => updateOutcomeScope(isElectron ? "desktop" : "web", primary), [primary]);
}

/** The sole production writer for last-result metadata. Never invokes update APIs. */
function changeHistory(
  scope: UpdateOutcomeScope | null,
  change: (history: UpdateOutcomeHistory) => UpdateOutcomeHistory | null,
): boolean {
  if (scope === null) return false;
  let saved = false;
  try { saved = writeUpdateOutcomeHistory(window.localStorage, scope, change); } catch { /* unavailable */ }
  if (saved) unavailableScopes.delete(scopeId(scope));
  else unavailableScopes.add(scopeId(scope));
  notifyHistoryChanged();
  return saved;
}

export function acknowledgeDisplayedUpdateOutcome(scope: UpdateOutcomeScope | null, id: string): boolean {
  if (scope === null) return false;
  let acknowledged = false;
  try { acknowledged = acknowledgeUpdateOutcomeNotice(window.localStorage, scope, id); } catch { /* unavailable */ }
  if (!acknowledged) unavailableScopes.add(scopeId(scope));
  notifyHistoryChanged();
  return acknowledged;
}

export function saveCompletedUpdateOutcome(
  scope: UpdateOutcomeScope | null, completed: LastCompletedUpdate,
): boolean {
  return changeHistory(scope, (previous) => completeUpdateOutcome(previous, completed));
}

export function prepareUpdateOutcome(
  scope: UpdateOutcomeScope | null, pending: Omit<PendingUpdateInstall, "previousCompletedId">,
): boolean {
  const saved = changeHistory(scope, (previous) => previous.pendingInstall && liveInstallIds.has(previous.pendingInstall.id) ? null
    : reservePendingUpdateOutcome(previous, pending));
  if (saved) liveInstallIds.add(pending.id);
  return saved;
}

export function discardPendingUpdateOutcome(scope: UpdateOutcomeScope | null, id: string): void {
  changeHistory(scope, (previous) => previous.pendingInstall?.id === id
    ? { ...previous, pendingInstall: null } : null);
  liveInstallIds.delete(id);
}

function readHistory(scope: UpdateOutcomeScope | null): UpdateHistoryRead {
  if (scope === null || unavailableScopes.has(scopeId(scope))) return { status: "unavailable" };
  try { return readUpdateOutcomeHistory(window.localStorage, scope); }
  catch { return { status: "unavailable" }; }
}

export function useLastUpdateOutcome() {
  const scope = useUpdateOutcomeScope();
  const revision = useAtomValue(historyRevisionAtom);
  const desktop = useDesktopUpdateState();
  const history = useMemo(() => readHistory(scope), [scope, revision]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith("t3code:update-everything:last-outcome:v2:")) notifyHistoryChanged();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (scope === null || history.status !== "ready") return;
    const fresh = readHistory(scope);
    if (fresh.status !== "ready") return;
    const pending = fresh.value.pendingInstall;
    if (pending && desktop && desktop.currentVersion === APP_VERSION && !liveInstallIds.has(pending.id)) {
      // Error snapshots have no attempt generation. Never use them to retire a live/retried handoff.
      const next = resolvePendingUpdateOutcome(fresh.value, desktop, Date.now(), pending.id);
      if (next) {
        const saved = changeHistory(scope, (current) => current.pendingInstall?.id === pending.id
          ? resolvePendingUpdateOutcome(current, desktop, Date.now(), pending.id) : null);
        if (saved) liveInstallIds.delete(pending.id);
        return;
      }
    }
    const completed = fresh.value.lastCompleted;
    if (!completed || fresh.value.pendingNoticeId !== completed.id) return;
    if (!acknowledgeDisplayedUpdateOutcome(scope, completed.id)) return;
    toastManager.add(stackedThreadToast({
      type: completed.rows.some((row) => row.status === "failed") ? "error"
        : completed.rows.every((row) => row.status === "updated") ? "success" : "warning",
      title: "Update results",
      description: "The last completed update result is available from Last update.",
    }));
  }, [scope, history, desktop]);

  const clear = () => {
    if (scope === null) return false;
    let cleared = false;
    try { cleared = clearUpdateOutcomeHistory(window.localStorage, scope); } catch { /* unavailable */ }
    if (cleared) unavailableScopes.delete(scopeId(scope));
    else unavailableScopes.add(scopeId(scope));
    notifyHistoryChanged();
    return cleared;
  };
  return { history, clear };
}

let notifiedNotAppliedVersion: string | null = null;

/**
 * Desktop launch notices for updates: the summary of a pass that ended with
 * this app's relaunch, and a warning when the last install did not apply.
 * Mount once at the app root.
 */
export function DesktopUpdateLaunchNotice() {
  useLastUpdateOutcome();
  const notAppliedVersion = useDesktopUpdateState()?.notAppliedVersion ?? null;

  useEffect(() => {
    const result = takeSavedUpdateEverythingResult();
    if (result) showUpdateEverythingResult(result);
  }, []);

  useEffect(() => {
    if (notAppliedVersion === null || notifiedNotAppliedVersion === notAppliedVersion) return;
    notifiedNotAppliedVersion = notAppliedVersion;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Update did not apply",
        description: `T3 Code is still on ${APP_VERSION}. Install ${notAppliedVersion} again from the update button.`,
      }),
    );
  }, [notAppliedVersion]);

  return null;
}
