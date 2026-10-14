import { useAtomValue } from "@effect/atom-react";
import { AuthEnvironmentMaintainScope, type EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { environmentCatalog } from "../connection/catalog";
import { bootstrapMissingFleetPeers } from "../connection/fleetBootstrap";
import { createFleetPairing, readFleetConnections } from "../connection/fleetClient";
import { connectPairing } from "../connection/onboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { toastManager } from "./ui/toast";

// Share one attempt across React remounts. Existing catalog entries remain authoritative.
const attempts = new Map<EnvironmentId, Promise<ReadonlyArray<string>>>();

function fleetAcknowledgments(primary: EnvironmentId) {
  const key = `morrowbyte:fleet-onboarded:${primary}`;
  const acknowledged = new Set<string>();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (Array.isArray(stored)) {
      for (const id of stored) if (typeof id === "string") acknowledged.add(id);
    }
  } catch {
    /* A blocked optional metadata store does not block pairing. */
  }
  return {
    has: (id: EnvironmentId) => acknowledged.has(id),
    remember: (id: EnvironmentId) => {
      acknowledged.add(id);
      try {
        localStorage.setItem(key, JSON.stringify([...acknowledged]));
      } catch {
        /* Best effort. */
      }
    },
  };
}

function connectFleet(primary: EnvironmentId) {
  const previous = attempts.get(primary);
  if (previous) return previous;
  const acknowledged = fleetAcknowledgments(primary);
  const attempt = readFleetConnections(primary).then((manifest) =>
    bootstrapMissingFleetPeers({
      primaryEnvironmentId: primary,
      peers: manifest.connections,
      hasSavedEnvironment: (id) => {
        const saved = appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.has(id);
        if (saved) acknowledged.remember(id);
        // An explicitly removed connection must not return on the next reload.
        return saved || acknowledged.has(id);
      },
      connect: async (peer) => {
        const grant = await createFleetPairing(primary, peer.environmentId);
        if (grant.environmentId !== peer.environmentId || grant.httpBaseUrl !== peer.httpBaseUrl) {
          throw new Error("Fleet pairing target changed.");
        }
        if (appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.has(peer.environmentId)) {
          acknowledged.remember(peer.environmentId);
          return;
        }
        const result = await connectPairing.run(appAtomRegistry, {
          host: grant.httpBaseUrl,
          pairingCode: grant.credential,
          expectedEnvironmentId: peer.environmentId,
        });
        if (result._tag === "Failure") throw new Error("Fleet pairing failed.");
        acknowledged.remember(peer.environmentId);
      },
    }),
  );
  attempts.set(primary, attempt);
  return attempt;
}

/** The owner-configured fleet becomes normal saved connections in each paired web client. */
export function FleetConnectionBootstrap() {
  const primary = usePrimaryEnvironmentId();
  const allowed = useEnvironmentScope(primary, AuthEnvironmentMaintainScope);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  useEffect(() => {
    if (window.desktopBridge || !primary || !allowed || !catalog.isReady) return;
    let active = true;
    void connectFleet(primary)
      .then((failures) => {
        if (active && failures.length) {
          toastManager.add({
            type: "error",
            title: `Could not connect: ${failures.join(", ")}`,
          });
        }
      })
      .catch(() => {
        // Older servers have no fleet endpoint; ordinary manual connections still work.
        attempts.delete(primary);
      });
    return () => {
      active = false;
    };
  }, [primary, allowed, catalog.isReady]);
  return null;
}
