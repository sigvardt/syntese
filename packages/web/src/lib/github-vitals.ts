import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TTLCache } from "./cache";
import type {
  GitHubProjectVitals,
  GitHubVitalsCIStatus,
  GitHubVitalsCommit,
  GitHubVitalsIssue,
  GitHubVitalsPullRequest,
  GitHubVitalsRecency,
} from "./types";

const execFileAsync = promisify(execFile);

const VITALS_TTL_MS = 60_000;
const DEFAULT_ISSUE_LIMIT = 20;
const DEFAULT_PR_LIMIT = 20;
const DEFAULT_COMMIT_LIMIT = 10;

type GhExecutor = (args: string[]) => Promise<string>;

const responseCache = new TTLCache<unknown>(VITALS_TTL_MS);
const etagByKey = new Map<string, string>();
const lastGoodByKey = new Map<string, unknown>();
const lastGoodProjectByKey = new Map<string, GitHubProjectVitals>();

let ghExecutor: GhExecutor = async (args) => {
  const { stdout } = await execFileAsync("gh", args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
};

class GitHubVitalsRateLimitError extends Error {
  readonly resetAt: string | null;

  constructor(message: string, resetAt: string | null) {
    super(message);
    this.name = "GitHubVitalsRateLimitError";
    this.resetAt = resetAt;
  }
}

interface HttpPayload {
  status: number;
  headers: Map<string, string>;
  body: string;
}

function parseRepo(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo || repository.split("/").length !== 2) {
    throw new Error(`Invalid repository format: ${repository}`);
  }
  return { owner, repo };
}

function parseHttpPayload(raw: string): HttpPayload {
  const matches = Array.from(raw.matchAll(/^HTTP\/\S+\s+(\d+)/gm));
  if (matches.length === 0) {
    return {
      status: 200,
      headers: new Map<string, string>(),
      body: raw.trim(),
    };
  }

  const last = matches[matches.length - 1];
  const start = last.index ?? 0;
  const section = raw.slice(start);
  const parts = section.split(/\r?\n\r?\n/);
  const head = parts[0] ?? "";
  const body = parts.slice(1).join("\n\n").trim();
  const lines = head.split(/\r?\n/);
  const status = Number(lines[0]?.match(/^HTTP\/\S+\s+(\d+)/)?.[1] ?? "500");

  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers.set(key, value);
  }

  return { status, headers, body };
}

async function requestGitHubJson<T>(cacheKey: string, endpoint: string): Promise<T> {
  const cached = responseCache.get(cacheKey) as T | null;
  if (cached) {
    return cached;
  }

  const args = ["api", "-i", "-H", "Accept: application/vnd.github+json"];
  const etag = etagByKey.get(cacheKey);
  if (etag) {
    args.push("-H", `If-None-Match: ${etag}`);
  }
  args.push(endpoint);

  let raw: string;
  try {
    raw = await ghExecutor(args);
  } catch (error) {
    const stale = lastGoodByKey.get(cacheKey) as T | undefined;
    if (stale !== undefined) {
      responseCache.set(cacheKey, stale, VITALS_TTL_MS);
      return stale;
    }
    throw error;
  }
  const payload = parseHttpPayload(raw);

  if (payload.status === 304) {
    const lastGood = lastGoodByKey.get(cacheKey) as T | undefined;
    if (lastGood === undefined) {
      throw new Error(`GitHub returned 304 for uncached endpoint: ${endpoint}`);
    }
    responseCache.set(cacheKey, lastGood, VITALS_TTL_MS);
    return lastGood;
  }

  if (payload.status === 403 || payload.status === 429) {
    const reset = payload.headers.get("x-ratelimit-reset");
    const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : null;
    throw new GitHubVitalsRateLimitError("GitHub API rate limit exceeded", resetAt);
  }

  if (payload.status < 200 || payload.status >= 300) {
    throw new Error(`GitHub API ${payload.status} for ${endpoint}`);
  }

  if (!payload.body) {
    throw new Error(`Empty GitHub API response for ${endpoint}`);
  }

  const data = JSON.parse(payload.body) as T;
  const nextEtag = payload.headers.get("etag");
  if (nextEtag) {
    etagByKey.set(cacheKey, nextEtag);
  }

  lastGoodByKey.set(cacheKey, data);
  responseCache.set(cacheKey, data, VITALS_TTL_MS);
  return data;
}

function normalizeCiStatus(state: string | undefined): GitHubVitalsCIStatus {
  const value = (state ?? "").toLowerCase();
  if (value === "success") return "passing";
  if (value === "failure" || value === "error") return "failing";
  if (value === "pending") return "pending";
  return "unknown";
}

function labelNames(raw: Array<{ name?: string }> | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((label) => label.name).filter((name): name is string => typeof name === "string");
}

interface GitHubIssueApiItem {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  labels: Array<{ name?: string }>;
  updated_at: string;
  created_at: string;
  closed_at?: string | null;
  pull_request?: Record<string, unknown>;
}

interface GitHubPullApiItem {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  labels: Array<{ name?: string }>;
  updated_at: string;
  created_at: string;
  merged_at?: string | null;
  head: {
    ref: string;
    sha: string;
  };
}

interface GitHubCommitApiItem {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
}

async function fetchCommitCiStatus(repository: string, sha: string): Promise<GitHubVitalsCIStatus> {
  const endpoint = `repos/${repository}/commits/${sha}/status`;
  const key = `ci:${repository}:${sha}`;
  const status = await requestGitHubJson<{ state?: string }>(key, endpoint);
  return normalizeCiStatus(status.state);
}

export async function fetchOpenIssues(
  repository: string,
  limit = DEFAULT_ISSUE_LIMIT,
): Promise<GitHubVitalsIssue[]> {
  const { owner, repo } = parseRepo(repository);
  const endpoint =
    `repos/${repository}/issues?state=open&sort=updated&direction=desc&per_page=${limit}`;
  const key = `issues:${repository}:${limit}`;
  const items = await requestGitHubJson<GitHubIssueApiItem[]>(key, endpoint);

  return items
    .filter((item) => item.pull_request === undefined)
    .map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      url: item.html_url,
      state: item.state,
      labels: labelNames(item.labels),
      owner,
      repo,
      updatedAt: item.updated_at,
      createdAt: item.created_at,
      correlations: [],
    }));
}

export async function fetchOpenPRs(
  repository: string,
  limit = DEFAULT_PR_LIMIT,
): Promise<GitHubVitalsPullRequest[]> {
  const { owner, repo } = parseRepo(repository);
  const endpoint =
    `repos/${repository}/pulls?state=open&sort=updated&direction=desc&per_page=${limit}`;
  const key = `prs:${repository}:${limit}`;
  const items = await requestGitHubJson<GitHubPullApiItem[]>(key, endpoint);

  const ciStates = await Promise.all(
    items.map(async (item) => {
      try {
        return await fetchCommitCiStatus(repository, item.head.sha);
      } catch {
        return "unknown" as const;
      }
    }),
  );

  return items.map((item, index) => ({
    id: item.id,
    number: item.number,
    title: item.title,
    url: item.html_url,
    state: item.merged_at ? "merged" : item.state,
    labels: labelNames(item.labels),
    owner,
    repo,
    branch: item.head.ref,
    sha: item.head.sha,
    updatedAt: item.updated_at,
    createdAt: item.created_at,
    ciStatus: ciStates[index] ?? "unknown",
    correlations: [],
  }));
}

export async function fetchRecentCommits(
  repository: string,
  limit = DEFAULT_COMMIT_LIMIT,
): Promise<GitHubVitalsCommit[]> {
  const { owner, repo } = parseRepo(repository);
  const endpoint = `repos/${repository}/commits?per_page=${limit}`;
  const key = `commits:${repository}:${limit}`;
  const items = await requestGitHubJson<GitHubCommitApiItem[]>(key, endpoint);

  return items.map((item) => ({
    sha: item.sha,
    shortSha: item.sha.slice(0, 7),
    message: item.commit.message.split("\n")[0] ?? item.sha,
    url: item.html_url,
    author: item.commit.author?.name ?? "unknown",
    pushedAt: item.commit.committer?.date ?? item.commit.author?.date ?? new Date(0).toISOString(),
    owner,
    repo,
  }));
}

async function fetchLastClosedIssueAt(repository: string): Promise<string | null> {
  const endpoint =
    `repos/${repository}/issues?state=closed&sort=updated&direction=desc&per_page=5`;
  const key = `recency:closed-issues:${repository}`;
  const items = await requestGitHubJson<GitHubIssueApiItem[]>(key, endpoint);
  const issue = items.find((item) => item.pull_request === undefined);
  return issue?.closed_at ?? issue?.updated_at ?? null;
}

async function fetchLastMergedPRAt(repository: string): Promise<string | null> {
  const endpoint =
    `repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=20`;
  const key = `recency:merged-pr:${repository}`;
  const items = await requestGitHubJson<GitHubPullApiItem[]>(key, endpoint);
  return items.find((item) => item.merged_at)?.merged_at ?? null;
}

export async function fetchRepoRecency(repository: string): Promise<GitHubVitalsRecency> {
  const [lastIssueClosedAt, lastPRMergedAt, commits] = await Promise.all([
    fetchLastClosedIssueAt(repository),
    fetchLastMergedPRAt(repository),
    fetchRecentCommits(repository, 1),
  ]);

  return {
    lastIssueClosedAt,
    lastPRMergedAt,
    lastCommitPushedAt: commits[0]?.pushedAt ?? null,
  };
}

export async function fetchProjectVitals(projectId: string, repository: string): Promise<GitHubProjectVitals> {
  const projectCacheKey = `${projectId}:${repository}`;
  try {
    const [issues, prs, commits, recency] = await Promise.all([
      fetchOpenIssues(repository),
      fetchOpenPRs(repository),
      fetchRecentCommits(repository),
      fetchRepoRecency(repository),
    ]);

    const fresh: GitHubProjectVitals = {
      projectId,
      repository,
      issues,
      prs,
      commits,
      recency,
      degraded: false,
    };

    lastGoodProjectByKey.set(projectCacheKey, fresh);
    return fresh;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch GitHub vitals";

    const stale = lastGoodProjectByKey.get(projectCacheKey);
    if (stale) {
      return {
        ...stale,
        degraded: true,
        error: message,
      };
    }

    return {
      projectId,
      repository,
      issues: [],
      prs: [],
      commits: [],
      recency: {
        lastIssueClosedAt: null,
        lastPRMergedAt: null,
        lastCommitPushedAt: null,
      },
      degraded: true,
      error: message,
    };
  }
}

export const __internal = {
  GitHubVitalsRateLimitError,
  parseHttpPayload,
  parseRepo,
  setGhExecutorForTests(executor: GhExecutor) {
    ghExecutor = executor;
  },
  resetForTests() {
    ghExecutor = async (args) => {
      const { stdout } = await execFileAsync("gh", args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      });
      return stdout;
    };
    responseCache.clear();
    etagByKey.clear();
    lastGoodByKey.clear();
    lastGoodProjectByKey.clear();
  },
  clearResponseCacheForTests() {
    responseCache.clear();
  },
};
