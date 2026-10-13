/** Identity and delivery gates for a Codex realtime session attached to a T3 thread. */
export interface CodexRealtimeLeaseIdentity {
  readonly environmentId: string;
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
  readonly runtimeGeneration: number;
  readonly nativeThreadId: string;
  readonly accountGeneration: number;
  readonly realtimeSessionId: string;
  readonly generation: number;
}

export interface CodexRealtimeReadbackIdentity {
  readonly runId: string;
  readonly attemptId: string;
  readonly finalMessageId: string;
  readonly sessionGeneration: number;
}

export type CodexRealtimeReadbackState = "pending" | "sent" | "unknown" | "failed";

/**
 * A lease is deliberately local to the adapter runtime. Realtime notifications
 * that omit session ids are safe only while this exact generation owns the
 * native thread. An ambiguous append is terminal for that readback key because
 * appendSpeech has no idempotency token.
 */
export class CodexRealtimeLease {
  readonly identity: CodexRealtimeLeaseIdentity;
  #closed = false;
  #readbacks = new Map<string, CodexRealtimeReadbackState>();

  constructor(identity: CodexRealtimeLeaseIdentity) {
    this.identity = identity;
  }

  owns(candidate: CodexRealtimeLeaseIdentity): boolean {
    return !this.#closed && sameLease(this.identity, candidate);
  }

  close(): void {
    this.#closed = true;
  }

  beginReadback(key: CodexRealtimeReadbackIdentity): boolean {
    if (this.#closed || key.sessionGeneration !== this.identity.generation) return false;
    const encoded = readbackKey(key);
    if (this.#readbacks.has(encoded)) return false;
    this.#readbacks.set(encoded, "pending");
    return true;
  }

  settleReadback(key: CodexRealtimeReadbackIdentity, state: Exclude<CodexRealtimeReadbackState, "pending">): boolean {
    const encoded = readbackKey(key);
    if (this.#readbacks.get(encoded) !== "pending") return false;
    this.#readbacks.set(encoded, state);
    return true;
  }

  readbackState(key: CodexRealtimeReadbackIdentity): CodexRealtimeReadbackState | undefined {
    return this.#readbacks.get(readbackKey(key));
  }
}

function sameLease(a: CodexRealtimeLeaseIdentity, b: CodexRealtimeLeaseIdentity): boolean {
  return a.environmentId === b.environmentId &&
    a.threadId === b.threadId &&
    a.providerInstanceId === b.providerInstanceId &&
    a.providerSessionId === b.providerSessionId &&
    a.runtimeGeneration === b.runtimeGeneration &&
    a.nativeThreadId === b.nativeThreadId &&
    a.accountGeneration === b.accountGeneration &&
    a.realtimeSessionId === b.realtimeSessionId &&
    a.generation === b.generation;
}

function readbackKey(key: CodexRealtimeReadbackIdentity): string {
  return `${key.runId}\u0000${key.attemptId}\u0000${key.finalMessageId}\u0000${key.sessionGeneration}`;
}
