import type { CodexRealtimeLeaseIdentity } from "./codexRealtimeLease.ts";

export type NativeVoiceObservation =
  | { readonly kind: "adopt-root"; readonly nativeTurnId: string; readonly nativeItemId: string }
  | { readonly kind: "steer"; readonly nativeTurnId: string; readonly nativeItemId: string; readonly runId: string };

/** Pure admission rules shared by the Codex adapter and offline protocol fixtures. */
export class CodexRealtimeAdoption {
  readonly lease: CodexRealtimeLeaseIdentity;
  #baselineReady = false;
  #policyReady = false;
  #typedStartPending = false;
  #activeRunId: string | undefined;
  #observed = new Set<string>();

  constructor(lease: CodexRealtimeLeaseIdentity) {
    this.lease = lease;
  }

  setBaselineReady(ready: boolean): void { this.#baselineReady = ready; }
  setPolicyReady(ready: boolean): void { this.#policyReady = ready; }
  setTypedStartPending(pending: boolean): void { this.#typedStartPending = pending; }
  setDurableActiveRun(runId: string | undefined): void { this.#activeRunId = runId; }

  observeNativeUserItem(input: {
    readonly lease: CodexRealtimeLeaseIdentity;
    readonly nativeTurnId: string;
    readonly nativeItemId: string;
  }): NativeVoiceObservation | undefined {
    if (!sameLease(this.lease, input.lease) || !this.#baselineReady || !this.#policyReady || this.#typedStartPending) {
      return undefined;
    }
    const key = `${input.nativeTurnId}\u0000${input.nativeItemId}`;
    if (this.#observed.has(key)) return undefined;
    this.#observed.add(key);
    if (this.#activeRunId !== undefined) {
      return { kind: "steer", nativeTurnId: input.nativeTurnId, nativeItemId: input.nativeItemId, runId: this.#activeRunId };
    }
    return { kind: "adopt-root", nativeTurnId: input.nativeTurnId, nativeItemId: input.nativeItemId };
  }

  /** Called only after the durable run/attempt terminal and child/checkpoint gates settle. */
  completeRun(runId: string): void {
    if (this.#activeRunId === runId) this.#activeRunId = undefined;
  }
}

function sameLease(a: CodexRealtimeLeaseIdentity, b: CodexRealtimeLeaseIdentity): boolean {
  return a.environmentId === b.environmentId && a.threadId === b.threadId &&
    a.providerInstanceId === b.providerInstanceId && a.providerSessionId === b.providerSessionId &&
    a.runtimeGeneration === b.runtimeGeneration && a.nativeThreadId === b.nativeThreadId &&
    a.accountGeneration === b.accountGeneration && a.realtimeSessionId === b.realtimeSessionId &&
    a.generation === b.generation;
}
