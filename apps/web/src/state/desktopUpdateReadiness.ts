import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { flushAndVerifyComposerDrafts } from "../composerDraftStore";

/** Granted media access cannot prove that a private call/recording runtime is
 * idle. Such renderers defer; this adapter never reaches into voice controls. */
export async function readRendererRuntimeReadiness(): Promise<"idle" | "busy" | "unknown"> {
  if (typeof navigator === "undefined" || navigator.permissions === undefined) return "unknown";
  // These controls own private hook runtimes. Their presence is a veto, never
  // an inference that a matching label means idle. Missing runtime observability
  // deliberately keeps the update staged, including an idle voice control.
  if (document.querySelector('[aria-label="Start voice call"], [aria-label="End Live voice"], [aria-label="Record voice message"], [aria-label="Stop recording"], [aria-label="Review saved voice recording"], [aria-label="Voice message processing"]')) return "unknown";
  if ([...document.querySelectorAll("audio,video")].some((element) =>
    element instanceof HTMLMediaElement && !element.paused && !element.ended,
  ) || window.speechSynthesis?.speaking || window.speechSynthesis?.pending) return "busy";
  try {
    const states = await Promise.all(["microphone", "camera"].map((name) =>
      navigator.permissions.query({ name: name as PermissionName }),
    ));
    return states.every((state) => state.state === "prompt" || state.state === "denied")
      ? "idle" : "unknown";
  } catch {
    return "unknown";
  }
}

export function createRendererUpdateReadiness(
  bridge: Pick<DesktopBridge, "acknowledgeUpdateReadiness">,
  runtime = readRendererRuntimeReadiness,
  persist = flushAndVerifyComposerDrafts,
) {
  let lastInteraction = Date.now();
  let currentGeneration: string | null = null;
  let previousInert = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  const interacted = () => { lastInteraction = Date.now(); };
  for (const event of ["pointerdown", "keydown", "input"]) document.addEventListener(event, interacted, true);
  const release = () => {
    revision += 1;
    if (timer !== undefined) clearTimeout(timer);
    if (currentGeneration !== null) document.documentElement.inert = previousInert;
    currentGeneration = null;
  };
  return {
    observe: async (state: DesktopUpdateState) => {
      const lease = state.installLease;
      if (lease === undefined) { release(); return; }
      if (bridge.acknowledgeUpdateReadiness === undefined) return;
      if (lease.phase === "commit") {
        if (currentGeneration === lease.generation && timer !== undefined) clearTimeout(timer);
        return;
      }
      if (Date.now() - lastInteraction < 60_000 || Date.now() >= lease.expiresAt) {
        try { await bridge.acknowledgeUpdateReadiness({ lease, ready: false }); } catch { /* Defer. */ }
        release();
        return;
      }
      if (currentGeneration !== lease.generation) {
        release();
        currentGeneration = lease.generation;
        previousInert = document.documentElement.inert;
        document.documentElement.inert = true;
        timer = setTimeout(release, Math.max(0, lease.expiresAt - Date.now()));
      }
      const capturedRevision = revision;
      const idle = await runtime();
      if (capturedRevision !== revision || currentGeneration !== lease.generation) return;
      const ready = Date.now() < lease.expiresAt && Date.now() - lastInteraction >= 60_000 &&
        idle === "idle" && persist();
      try { await bridge.acknowledgeUpdateReadiness({ lease, ready }); } catch { release(); }
      if (!ready) release();
    },
    dispose: () => {
      release();
      for (const event of ["pointerdown", "keydown", "input"]) document.removeEventListener(event, interacted, true);
    },
  };
}
