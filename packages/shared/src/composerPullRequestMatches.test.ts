import { describe, expect, it } from "vite-plus/test";

import type { ThreadPullRequestLink } from "@t3tools/contracts";

import {
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
} from "./composerPullRequestMatches.ts";

const entry = (number: number, updatedAt: string) => ({
  number,
  projectId: "p1",
  repository: "owner/repo",
  updatedAt,
});

describe("filterComposerPullRequestMatches", () => {
  it("ranks the exact number above newer substring matches", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(1234, "2026-01-03"), entry(123, "2026-01-01"), entry(1230, "2026-01-02")],
      projectId: "p1",
      repository: "owner/repo",
      query: "123",
      limit: 10,
    });
    expect(result.map((match) => match.number)).toEqual([123, 1234, 1230]);
  });

  it("leaves the caller's array untouched", () => {
    // The sort runs on a copy; mutating the input would reorder whatever the caller holds.
    const entries = [entry(2, "2026-01-01"), entry(1, "2026-01-02")];
    const snapshot = entries.map((match) => match.number);
    filterComposerPullRequestMatches({
      entries,
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 10,
    });
    expect(entries.map((match) => match.number)).toEqual(snapshot);
  });

  it("de-duplicates and honours the limit", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(7, "2026-01-02"), entry(7, "2026-01-01"), entry(8, "2026-01-03")],
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 1,
    });
    expect(result).toHaveLength(1);
  });
});

describe("thread-linked pull request suggestions", () => {
  const link = (
    repository: string,
    number: number,
    overrides: Partial<ThreadPullRequestLink> = {},
  ): ThreadPullRequestLink => ({
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    source: "agent",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      state: "open",
      title: `${repository} ${number}`,
      headBranch: "feature",
      baseBranch: "main",
      isDraft: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
      syncedAt: "2026-01-02T00:00:00.000Z",
    },
    stack: null,
    ...overrides,
  });

  it("allows visible foreign linked rows while fencing listing rows by both project and repository", () => {
    const projectRow = entry(4, "2026-01-04");
    const linked = composerPullRequestsFromLinks([link("foreign/repo", 4)], "p1");
    const result = filterComposerPullRequestMatches({
      entries: [
        projectRow,
        { ...entry(4, "2026-01-05"), repository: "foreign/unlinked" },
        { ...entry(4, "2026-01-06"), projectId: "another-project" },
      ],
      linked,
      projectId: "p1",
      repository: " OWNER/REPO ",
      query: "4",
      limit: 10,
    });
    expect(result.map((row) => `${row.repository}#${row.number}`)).toEqual([
      "foreign/repo#4",
      "owner/repo#4",
    ]);
    expect(result[0]).toBe(linked[0]);
    expect(result[1]).toBe(projectRow);
  });

  it("keeps the exact listed number above newer linked substring matches under a one-row limit", () => {
    const exact = entry(12, "2025-01-01");
    const result = filterComposerPullRequestMatches({
      entries: [entry(1200, "2026-01-03"), exact],
      linked: composerPullRequestsFromLinks([link("foreign/repo", 123)], "p1"),
      projectId: "p1",
      repository: "owner/repo",
      query: "12",
      limit: 1,
    });
    expect(result).toEqual([exact]);
    expect(result[0]).toBe(exact);
  });

  it("ranks linked substring matches before listing substrings, newest linked first", () => {
    const newer = link("foreign/repo", 124);
    if (newer.snapshot === null) throw new Error("Expected a synced fixture");
    const linked = composerPullRequestsFromLinks(
      [
        link("foreign/repo", 123),
        {
          ...newer,
          snapshot: { ...newer.snapshot, updatedAt: "2026-01-03T00:00:00.000Z" },
        },
      ],
      "p1",
    );
    const result = filterComposerPullRequestMatches({
      entries: [entry(125, "2026-02-01")],
      linked,
      projectId: "p1",
      repository: "owner/repo",
      query: "12",
      limit: 3,
    });
    expect(result.map((row) => row.number)).toEqual([124, 123, 125]);
  });

  it("deduplicates by trimmed case-insensitive repository and number while retaining the listing row", () => {
    const projectRow = entry(4, "2026-01-03");
    const firstLink = { ...entry(4, "2026-02-01"), repository: " OWNER/REPO " };
    const duplicateLink = { ...entry(4, "2026-01-02"), repository: "Owner/Repo" };
    const distinctRepository = { ...entry(4, "2026-01-01"), repository: "foreign/repo" };
    const distinctNumber = { ...entry(5, "2026-01-01"), repository: "owner/repo" };
    const result = filterComposerPullRequestMatches({
      entries: [projectRow, entry(4, "2026-01-01")],
      linked: [firstLink, duplicateLink, distinctRepository, distinctNumber],
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 10,
    });
    expect(result).toEqual([projectRow, distinctRepository, distinctNumber]);
    expect(result[0]).toBe(projectRow);
    expect(result).not.toContain(firstLink);
    expect(result).not.toContain(duplicateLink);
  });

  it("does not suggest unsynced or dismissed links", () => {
    const visible = link("foreign/visible", 6);
    expect(
      composerPullRequestsFromLinks(
        [
          link("foreign/unsynced", 4, { snapshot: null }),
          link("foreign/dismissed", 5, { source: "stack-dismissed" }),
          visible,
        ],
        "p1",
      ),
    ).toEqual([
      {
        projectId: "p1",
        repository: visible.repository,
        number: visible.number,
        url: visible.url,
        title: "foreign/visible 6",
        headBranch: "feature",
        baseBranch: "main",
        state: "open",
        isDraft: false,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("falls back to linkedAt only when the synced snapshot has no update timestamp", () => {
    const original = link("foreign/repo", 7);
    if (original.snapshot === null) throw new Error("Expected a synced fixture");
    const withoutUpdatedAt = {
      ...original,
      linkedAt: "2026-01-04T00:00:00.000Z",
      snapshot: { ...original.snapshot, updatedAt: null },
    };
    const rows = composerPullRequestsFromLinks([withoutUpdatedAt, original], "destination-project");
    expect(rows.map((row) => row.updatedAt)).toEqual([
      "2026-01-04T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    ]);
    expect(rows.map((row) => row.projectId)).toEqual([
      "destination-project",
      "destination-project",
    ]);
  });

  it("does not mutate frozen listings, linked rows or source link snapshots", () => {
    const source = link("foreign/repo", 4);
    if (source.snapshot === null) throw new Error("Expected a synced fixture");
    Object.freeze(source.snapshot);
    Object.freeze(source);
    const links = Object.freeze([source]);
    const linked = Object.freeze(
      composerPullRequestsFromLinks(links, "p1").map((row) => Object.freeze(row)),
    );
    const first = Object.freeze(entry(8, "2026-01-03"));
    const second = Object.freeze(entry(3, "2026-01-01"));
    const entries = Object.freeze([first, second]);
    const sourceBefore = { ...source, snapshot: { ...source.snapshot } };
    const linkedBefore = linked.map((row) => ({ ...row }));
    const result = filterComposerPullRequestMatches({
      entries,
      linked,
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 3,
    });
    expect(result.map((row) => row.number)).toEqual([4, 8, 3]);
    expect(entries).toEqual([first, second]);
    expect(linked).toEqual(linkedBefore);
    expect(links).toEqual([sourceBefore]);
    expect(source.snapshot.title).toBe("foreign/repo 4");
  });
});
