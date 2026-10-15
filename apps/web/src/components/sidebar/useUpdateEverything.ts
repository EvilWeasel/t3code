import { useAtomValue } from "@effect/atom-react";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { environmentSession } from "~/state/session";
import { getProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";
import { useProviderUpdates } from "../ProviderUpdatesAction";
import { canUpdateServer, useServerUpdate } from "../ServerUpdateAction";
import {
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  describeUpdateEverything,
  installAfterUpdateEverything,
  runUpdateEverything,
  type UpdateRunMachine,
} from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
  settleUpdateRunMachine,
  showUpdateEverythingResult,
} from "./updateEverythingRun";

/** Where this app's own download or install reports a failure. */
export type ReportLocalUpdateError = (title: string, description: string) => void;

/**
 * The remote half of the sidebar update button: outdated providers on every
 * connected machine, and servers behind the version this client runs or is
 * about to install (`localUpdateVersion`). Managed servers use verified release
 * archives. `run` performs the whole pass, including
 * this app's own download and install when given. It tracks per-machine results
 * and keeps their summary through a local relaunch.
 */
export function useUpdateEverything(localUpdateVersion: string | null) {
  const targetVersion = localUpdateVersion ?? APP_VERSION;
  const { environments } = useEnvironments();
  const machinesAtom = useMemo(
    () =>
      Atom.make((get) =>
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          serverConfig: environment.serverConfig,
          connected: environment.connection.phase === "connected",
          hostedByThisApp:
            isElectron &&
            (environment.entry.target._tag === "PrimaryConnectionTarget" ||
              isDesktopLocalConnectionTarget(environment.entry.target)),
          canMaintain: canUpdateServer(
            get(environmentSession.sessionStateAtom(environment.environmentId)),
          ),
          updateState: get(serverEnvironment.updateStateAtom(environment.environmentId)),
        })),
      ),
    [environments],
  );
  const machines = useAtomValue(machinesAtom);
  // Managed servers install verified fork archives, independently of npm publication.
  const { targets: servers, skipped } = collectServerUpdateTargets(machines, targetVersion);
  const restarts = collectRestartingMachines(machines, servers, localUpdateVersion !== null);
  const providers = useProviderUpdates();
  const updateServer = useServerUpdate();

  const { summary, lines } = describeUpdateEverything({
    localVersion: localUpdateVersion,
    servers,
    providerMachines: providers.machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      providers: machine.candidates.map(
        (candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
      ),
    })),
  });

  return {
    hasUpdates: servers.length > 0 || providers.machines.length > 0,
    /** Short label for the tooltip and the confirmation title. */
    summary,
    /** One line per machine, for the confirmation. */
    lines,
    /** The servers this run restarts, which stops their running threads. */
    restarts,
    /** Behind machines the run leaves alone, with the reason. */
    skipped,
    /** Runs the pass. `installLocal` resolves true when this app is relaunching.
        Both report failures to the pass, which lists them in its summary. */
    run: async ({
      downloadLocal,
      installLocal,
    }: {
      downloadLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
      installLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
    }) => {
      const localFailures: Array<string> = [];
      const reportLocalError: ReportLocalUpdateError = (title, description) => {
        localFailures.push(`${title}: ${description}`);
      };
      const machinesById = new Map<UpdateRunMachine["environmentId"], UpdateRunMachine>();
      for (const machine of providers.machines) {
        machinesById.set(machine.environmentId, {
          environmentId: machine.environmentId,
          label: machine.label,
          updatesProviders: true,
          updatesServer: false,
          result: null,
        });
      }
      for (const server of servers) {
        const existing = machinesById.get(server.environmentId);
        machinesById.set(server.environmentId, {
          environmentId: server.environmentId,
          label: server.serverLabel,
          updatesProviders: existing?.updatesProviders ?? false,
          updatesServer: true,
          result: null,
        });
      }
      const localVersion = installLocal ? localUpdateVersion : null;
      setUpdateEverythingRun(() => ({
        localVersion,
        phase: "providers",
        machines: Array.from(machinesById.values()),
      }));
      const failedProviderMachines = new Set<UpdateRunMachine["environmentId"]>();
      try {
        const outcome = await runUpdateEverything({
          ...(downloadLocal ? { downloadLocal: () => downloadLocal(reportLocalError) } : {}),
          updateProviders: async () => {
            const runs = await providers.updateAll({ quiet: true });
            const outcomes = runs.map((run) => {
              const runOutcome = getProviderUpdateRunOutcome(run);
              // An interrupted update did not finish either, so its row is not "done".
              if (runOutcome.status !== "updated") failedProviderMachines.add(run.environmentId);
              return runOutcome;
            });
            for (const machine of machinesById.values()) {
              if (!machine.updatesServer) {
                settleUpdateRunMachine(
                  machine.environmentId,
                  failedProviderMachines.has(machine.environmentId) ? "failed" : "done",
                );
              }
            }
            setUpdateEverythingRun((run) => run && { ...run, phase: "servers" });
            return outcomes;
          },
          updateServers: () =>
            Promise.all(
              servers.map(async (server) => {
                const serverOutcome = await updateServer(server, { quiet: true });
                settleUpdateRunMachine(
                  server.environmentId,
                  serverOutcome.status === "failed" ||
                    failedProviderMachines.has(server.environmentId)
                    ? "failed" : serverOutcome.status === "skipped" ? "skipped" : "done",
                );
                return { label: server.serverLabel, outcome: serverOutcome };
              }),
            ),
        });
        const result = () =>
          collectUpdateEverythingResult({
            localVersion: null,
            localFailures,
            skipped,
            servers: outcome.servers,
            providers: outcome.providers,
          });
        if (outcome.localReady && installLocal) {
          setUpdateEverythingRun((run) => run && { ...run, phase: "installing" });
          const installOutcome = await installAfterUpdateEverything({
            result: { ...result(), localVersion },
            localReady: outcome.localReady,
            save: saveUpdateEverythingResult,
            install: () => installLocal(reportLocalError),
            clear: clearSavedUpdateEverythingResult,
          });
          if (installOutcome === "relaunching") return;
          if (installOutcome === "storage-failed") {
            reportLocalError("Update remains ready", "Could not save the update results. The app will stay open so those results are preserved.");
          }
        }
        showUpdateEverythingResult(result());
      } finally {
        setUpdateEverythingRun(() => null);
      }
    },
  };
}
