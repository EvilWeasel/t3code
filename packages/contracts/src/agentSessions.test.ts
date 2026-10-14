import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentSessionImportResult, AgentSessionScanResult } from "./agentSessions.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionImportResult", () => {
  const decode = Schema.decodeUnknownSync(AgentSessionImportResult);
  const opaque = {
    providerInstanceId: "codex",
    providerSessionId: "synthetic-native-session",
    status: "skipped",
    recoverability: "compaction-context",
    reason: "opaque-context",
    nativeContinuationEligible: false,
  } as const;

  it("preserves the legacy counts-only response", () => {
    expect(decode({ importedCount: 0, skippedCount: 6 })).toEqual({ importedCount: 0, skippedCount: 6 });
  });

  it("reports opaque context without exposing transcript fields or claiming native resume", () => {
    const result = decode({ importedCount: 0, skippedCount: 1, outcomes: [{
      ...opaque, filePath: "/synthetic/private-path", encrypted_content: "synthetic-secret-canary", summary: "Synthetic context",
    }] });
    expect(result.outcomes).toEqual([opaque]);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-canary");
    expect(JSON.stringify(result)).not.toContain("/synthetic/private-path");
  });

  it.each(["compaction-context", "summary-only", "metadata-only", "unrecoverable"])("rejects native eligibility for %s even with an ID", (recoverability) => {
    expect(() => decode({ importedCount: 0, skippedCount: 1, outcomes: [{
      ...opaque, status: "imported", recoverability, nativeContinuationEligible: true,
    }] })).toThrow();
  });

  it("rejects eligible conversation without a recorded native ID", () => {
    expect(() => decode({ importedCount: 1, skippedCount: 0, outcomes: [{
      ...opaque, status: "imported", recoverability: "conversation", reason: "imported", providerSessionId: null, nativeContinuationEligible: true,
    }] })).toThrow();
  });

  it("accepts a structural conversation candidate without claiming runtime verification", () => {
    expect(decode({ importedCount: 1, skippedCount: 0, outcomes: [{
      ...opaque, status: "imported", recoverability: "conversation", reason: "imported", nativeContinuationEligible: true,
    }] }).outcomes?.[0]?.nativeContinuationEligible).toBe(true);
  });

  it("rejects unknown outcome discriminators", () => {
    expect(() => decode({ importedCount: 0, skippedCount: 1, outcomes: [{ ...opaque, reason: "restored-everything" }] })).toThrow();
  });
});

describe("AgentSessionScanResult", () => {
  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });
});
