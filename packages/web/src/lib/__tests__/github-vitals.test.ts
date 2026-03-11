import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __internal,
  fetchOpenIssues,
  fetchOpenPRs,
  fetchProjectVitals,
  fetchRecentCommits,
} from "../github-vitals";

function httpResponse(status: number, body: unknown, headers: Record<string, string> = {}): string {
  const lines = [`HTTP/2 ${status}`];
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`${key}: ${value}`);
  }
  return `${lines.join("\n")}\n\n${JSON.stringify(body)}`;
}

afterEach(() => {
  __internal.resetForTests();
  vi.restoreAllMocks();
});

describe("github vitals client", () => {
  it("fetchOpenIssues filters out pull request issue rows", async () => {
    __internal.setGhExecutorForTests(async () =>
      httpResponse(200, [
        {
          id: 1,
          number: 10,
          title: "Issue item",
          html_url: "https://github.com/acme/app/issues/10",
          state: "open",
          labels: [{ name: "bug" }],
          updated_at: "2026-03-11T12:00:00.000Z",
          created_at: "2026-03-10T12:00:00.000Z",
        },
        {
          id: 2,
          number: 11,
          title: "PR masquerading as issue",
          html_url: "https://github.com/acme/app/pull/11",
          state: "open",
          labels: [],
          updated_at: "2026-03-11T12:00:00.000Z",
          created_at: "2026-03-10T12:00:00.000Z",
          pull_request: { url: "https://api.github.com/repos/acme/app/pulls/11" },
        },
      ]),
    );

    const issues = await fetchOpenIssues("acme/app");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(10);
  });

  it("fetchOpenPRs attaches CI state from commit status", async () => {
    const executor = vi
      .fn(async (_args: string[]) => "")
      .mockImplementationOnce(async () =>
        httpResponse(200, [
          {
            id: 1,
            number: 99,
            title: "feat: add vitals",
            html_url: "https://github.com/acme/app/pull/99",
            state: "open",
            labels: [],
            updated_at: "2026-03-11T12:00:00.000Z",
            created_at: "2026-03-10T12:00:00.000Z",
            merged_at: null,
            head: { ref: "feat/vitals", sha: "abc123" },
          },
        ]),
      )
      .mockImplementationOnce(async () => httpResponse(200, { state: "success" }));

    __internal.setGhExecutorForTests(executor);

    const prs = await fetchOpenPRs("acme/app");
    expect(prs).toHaveLength(1);
    expect(prs[0]?.ciStatus).toBe("passing");
  });

  it("fetchRecentCommits normalizes message and author", async () => {
    __internal.setGhExecutorForTests(async () =>
      httpResponse(200, [
        {
          sha: "abcdef1234567890",
          html_url: "https://github.com/acme/app/commit/abcdef1234567890",
          commit: {
            message: "feat: add vitals panel\n\nextra details",
            author: { name: "alex", date: "2026-03-11T11:00:00.000Z" },
            committer: { date: "2026-03-11T11:05:00.000Z" },
          },
        },
      ]),
    );

    const commits = await fetchRecentCommits("acme/app", 1);
    expect(commits[0]?.shortSha).toBe("abcdef1");
    expect(commits[0]?.message).toBe("feat: add vitals panel");
  });

  it("fetchProjectVitals degrades gracefully on rate limiting", async () => {
    __internal.setGhExecutorForTests(async () =>
      httpResponse(403, { message: "rate limit" }, { "x-ratelimit-reset": "0" }),
    );

    const vitals = await fetchProjectVitals("app", "acme/app");
    expect(vitals.degraded).toBe(true);
    expect(vitals.issues).toEqual([]);
    expect(vitals.prs).toEqual([]);
  });

  it("uses ETag conditional request and 304 response", async () => {
    const executor = vi
      .fn(async (_args: string[]) => "")
      .mockImplementationOnce(async () =>
        httpResponse(
          200,
          [
            {
              id: 1,
              number: 10,
              title: "Issue item",
              html_url: "https://github.com/acme/app/issues/10",
              state: "open",
              labels: [],
              updated_at: "2026-03-11T12:00:00.000Z",
              created_at: "2026-03-10T12:00:00.000Z",
            },
          ],
          { etag: "W/\"etag-v1\"" },
        ),
      )
      .mockImplementationOnce(async () => httpResponse(304, []));

    __internal.setGhExecutorForTests(executor);

    const first = await fetchOpenIssues("acme/app");
    expect(first).toHaveLength(1);

    __internal.clearResponseCacheForTests();
    const second = await fetchOpenIssues("acme/app");
    expect(second).toHaveLength(1);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[1]?.[0]).toContain("If-None-Match: W/\"etag-v1\"");
  });
});
