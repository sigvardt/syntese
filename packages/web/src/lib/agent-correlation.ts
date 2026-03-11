import type { Session } from "@syntese/core";
import type {
  GitHubVitalsIssue,
  GitHubVitalsPullRequest,
  VitalsCorrelationReason,
  VitalsSessionCorrelation,
} from "./types";

interface SessionRef {
  sessionId: string;
  projectId: string;
}

interface SessionCorrelationIndex {
  byPrNumber: Map<number, SessionRef[]>;
  byIssueNumber: Map<number, SessionRef[]>;
  byBranch: Map<string, SessionRef[]>;
  bySessionToken: Map<string, SessionRef[]>;
  sessions: Session[];
}

function addToMap<K>(map: Map<K, SessionRef[]>, key: K, value: SessionRef): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [value]);
    return;
  }
  if (!existing.some((item) => item.sessionId === value.sessionId)) {
    existing.push(value);
  }
}

function normalizeBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  return branch.trim().toLowerCase();
}

function extractNumber(value: string | null | undefined, pattern: RegExp): number | null {
  if (!value) return null;
  const match = value.match(pattern);
  if (!match?.[1]) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

function extractIssueNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  if (/^\d+$/u.test(value.trim())) {
    const numeric = Number(value.trim());
    return Number.isFinite(numeric) ? numeric : null;
  }
  return extractNumber(value, /\/issues\/(\d+)(?:$|[/?#])/u);
}

function extractPRNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  if (/^\d+$/u.test(value.trim())) {
    const numeric = Number(value.trim());
    return Number.isFinite(numeric) ? numeric : null;
  }
  return extractNumber(value, /\/pull\/(\d+)(?:$|[/?#])/u);
}

function extractSessionToken(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  const match = normalized.match(/\b([a-z][a-z0-9_-]*-\d+)\b/u);
  return match?.[1] ?? null;
}

function toCorrelations(
  reasons: Map<string, { ref: SessionRef; reason: VitalsCorrelationReason }>,
): VitalsSessionCorrelation[] {
  return Array.from(reasons.values())
    .map(({ ref, reason }) => ({
      sessionId: ref.sessionId,
      projectId: ref.projectId,
      reason,
    }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

function setReason(
  map: Map<string, { ref: SessionRef; reason: VitalsCorrelationReason }>,
  ref: SessionRef,
  reason: VitalsCorrelationReason,
): void {
  const existing = map.get(ref.sessionId);
  if (!existing) {
    map.set(ref.sessionId, { ref, reason });
    return;
  }

  const priority: Record<VitalsCorrelationReason, number> = {
    pr_number: 4,
    issue_number: 3,
    branch: 2,
    session_id: 1,
  };

  if (priority[reason] > priority[existing.reason]) {
    map.set(ref.sessionId, { ref, reason });
  }
}

export function buildSessionCorrelationIndex(sessions: Session[]): SessionCorrelationIndex {
  const byPrNumber = new Map<number, SessionRef[]>();
  const byIssueNumber = new Map<number, SessionRef[]>();
  const byBranch = new Map<string, SessionRef[]>();
  const bySessionToken = new Map<string, SessionRef[]>();

  for (const session of sessions) {
    const ref: SessionRef = { sessionId: session.id, projectId: session.projectId };

    if (session.pr?.number) {
      addToMap(byPrNumber, session.pr.number, ref);
    }
    const metadataPr = extractPRNumber(session.metadata["pr"] ?? session.metadata["prNumber"]);
    if (metadataPr !== null) {
      addToMap(byPrNumber, metadataPr, ref);
    }

    const issueNumber = extractIssueNumber(session.issueId);
    if (issueNumber !== null) {
      addToMap(byIssueNumber, issueNumber, ref);
    }
    const metadataIssue = extractIssueNumber(
      session.metadata["issue"] ?? session.metadata["issueNumber"],
    );
    if (metadataIssue !== null) {
      addToMap(byIssueNumber, metadataIssue, ref);
    }

    const sessionBranch = normalizeBranch(session.branch);
    if (sessionBranch) {
      addToMap(byBranch, sessionBranch, ref);
    }
    const metadataBranch = normalizeBranch(session.metadata["branch"]);
    if (metadataBranch) {
      addToMap(byBranch, metadataBranch, ref);
    }

    const token = extractSessionToken(session.id);
    if (token) {
      addToMap(bySessionToken, token, ref);
    }
  }

  return { byPrNumber, byIssueNumber, byBranch, bySessionToken, sessions };
}

export function correlatePullRequests(
  prs: GitHubVitalsPullRequest[],
  sessionsOrIndex: Session[] | SessionCorrelationIndex,
): GitHubVitalsPullRequest[] {
  const index = Array.isArray(sessionsOrIndex)
    ? buildSessionCorrelationIndex(sessionsOrIndex)
    : sessionsOrIndex;

  return prs.map((pr) => {
    const matches = new Map<string, { ref: SessionRef; reason: VitalsCorrelationReason }>();

    for (const ref of index.byPrNumber.get(pr.number) ?? []) {
      setReason(matches, ref, "pr_number");
    }

    const branch = normalizeBranch(pr.branch);
    if (branch) {
      for (const ref of index.byBranch.get(branch) ?? []) {
        setReason(matches, ref, "branch");
      }

      for (const [token, refs] of index.bySessionToken.entries()) {
        if (branch.includes(token)) {
          for (const ref of refs) {
            setReason(matches, ref, "session_id");
          }
        }
      }
    }

    return {
      ...pr,
      correlations: toCorrelations(matches),
    };
  });
}

export function correlateIssues(
  issues: GitHubVitalsIssue[],
  sessionsOrIndex: Session[] | SessionCorrelationIndex,
): GitHubVitalsIssue[] {
  const index = Array.isArray(sessionsOrIndex)
    ? buildSessionCorrelationIndex(sessionsOrIndex)
    : sessionsOrIndex;

  return issues.map((issue) => {
    const matches = new Map<string, { ref: SessionRef; reason: VitalsCorrelationReason }>();

    for (const ref of index.byIssueNumber.get(issue.number) ?? []) {
      setReason(matches, ref, "issue_number");
    }

    for (const session of index.sessions) {
      const branch = normalizeBranch(session.branch);
      if (!branch) continue;
      const issuePattern = new RegExp(`(^|[-/])${issue.number}(?:$|[-/])`, "u");
      if (issuePattern.test(branch)) {
        setReason(matches, { sessionId: session.id, projectId: session.projectId }, "branch");
      }
    }

    return {
      ...issue,
      correlations: toCorrelations(matches),
    };
  });
}
