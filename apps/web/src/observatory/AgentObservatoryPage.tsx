import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { createLiveObservatory } from "@t3tools/client-runtime/observatory";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useContext, useState, Suspense } from "react";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { buildThreadRouteParams } from "../threadRoutes";
import { V2ItemInspector } from "../components/chat/V2ItemInspector";
import { AgentObservatory } from "./AgentObservatory";

export function AgentObservatoryPage() {
  // A remount starts with a fresh connection observation, never retained live detail.
  const [observatory] = useState(() =>
    createLiveObservatory(connectionAtomRuntime, environmentCatalog.catalogValueAtom),
  );
  const view = useAtomValue(observatory.snapshotAtom);
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const openThread = (ref: ScopedThreadRef) => {
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };
  return (
    <AgentObservatory
      view={view}
      onSelect={(ref) => registry.set(observatory.selectedAtom, ref)}
      onOpenThread={openThread}
      renderTool={(row, ref) => (
        <Suspense fallback={<p>Loading selected entry…</p>}>
          <V2ItemInspector
            projectedItem={row}
            environmentId={ref.environmentId}
            onOpenThread={(threadId) => openThread({ ...ref, threadId })}
            onOpenTurnDiff={() => openThread(ref)}
          />
        </Suspense>
      )}
    />
  );
}
