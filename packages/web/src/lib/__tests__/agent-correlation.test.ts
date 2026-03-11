import { describe, it, expect } from "vitest";
import type { Session } from "@syntese/core";
import { buildSessionCorrelationIndex, correlateIssues, correlatePullRequests } from "../agent-correlation";

function createSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    id: overrides.id,
    projectId: overrides.projectId ?? "app",
    status: overrides.status ?? "working",
    activity: overrides.activity ?? "active",
    branch: overrides.branch ?? null,
    issueId: overrides.issueId ?? null,
    pr: overrides.pr ?? null,
    workspacePath: overrides.workspacePath ?? null,
    runtimeHandle: overrides.runtimeHandle ?? null,
    agentInfo: overrides.agentInfo ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    lastActivityAt: overrides.lastActivityAt ?? new Date(),
    metadata: overrides.metadata ?? {},
  };
}

describe("agent correlation", () => {
  it("correlates pull requests by explicit PR number metadata", () => {
    const sessions = [
      createSession({
        id: "app-7",
        metadata: { pr: "https://github.com/acme/app/pull/42" },
      }),
    ];

    const prs = [
      {
        id: 1,
        number: 42,
        title: "feat: add dashboard vitals",
        url: "https://github.com/acme/app/pull/42",
        state: "open" as const,
        labels: [],
        owner: "acme",
        repo: "app",
        branch: "feat/dashboard-vitals",
        sha: "1234567890",
        updatedAt: "2026-03-11T10:00:00.000Z",
        createdAt: "2026-03-11T09:00:00.000Z",
        ciStatus: "passing" as const,
        correlations: [],
      },
    ];

    const correlated = correlatePullRequests(prs, sessions);
    expect(correlated[0]?.correlations).toEqual([
      { sessionId: "app-7", projectId: "app", reason: "pr_number" },
    ]);
  });

  it("correlates pull requests by branch and session id token", () => {
    const sessions = [createSession({ id: "api-3", branch: "feat/api-3-github-vitals" })];

    const prs = [
      {
        id: 1,
        number: 99,
        title: "feat: branch-based correlation",
        url: "https://github.com/acme/app/pull/99",
        state: "open" as const,
        labels: [],
        owner: "acme",
        repo: "app",
        branch: "feat/api-3-github-vitals",
        sha: "1234567890",
        updatedAt: "2026-03-11T10:00:00.000Z",
        createdAt: "2026-03-11T09:00:00.000Z",
        ciStatus: "passing" as const,
        correlations: [],
      },
    ];

    const index = buildSessionCorrelationIndex(sessions);
    const correlated = correlatePullRequests(prs, index);

    expect(correlated[0]?.correlations.length).toBe(1);
    expect(correlated[0]?.correlations[0]?.reason).toBe("branch");
  });

  it("correlates issues by issue url and branch number pattern", () => {
    const sessions = [
      createSession({
        id: "app-4",
        branch: "feat/123-refresh-vitals",
        issueId: "https://github.com/acme/app/issues/123",
      }),
    ];

    const issues = [
      {
        id: 777,
        number: 123,
        title: "GitHub vitals follow-up",
        url: "https://github.com/acme/app/issues/123",
        state: "open" as const,
        labels: [],
        owner: "acme",
        repo: "app",
        updatedAt: "2026-03-11T10:00:00.000Z",
        createdAt: "2026-03-11T09:00:00.000Z",
        correlations: [],
      },
    ];

    const correlated = correlateIssues(issues, sessions);
    expect(correlated[0]?.correlations).toEqual([
      { sessionId: "app-4", projectId: "app", reason: "issue_number" },
    ]);
  });
});
