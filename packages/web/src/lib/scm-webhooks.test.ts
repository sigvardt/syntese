import { describe, expect, it } from "vitest";
import type { ProjectConfig, SCMWebhookEvent } from "@composio/ao-core";
import { eventMatchesProject } from "./scm-webhooks";

const project: ProjectConfig = {
  name: "my-app",
  repo: "acme/my-app",
  path: "/tmp/my-app",
  defaultBranch: "main",
  sessionPrefix: "my-app",
};

describe("eventMatchesProject", () => {
  it("matches when repository owner/name equals project repo", () => {
    const event: SCMWebhookEvent = {
      provider: "github",
      kind: "pull_request",
      action: "opened",
      rawEventType: "pull_request",
      repository: { owner: "acme", name: "my-app" },
      data: {},
    };

    expect(eventMatchesProject(event, project)).toBe(true);
  });

  it("does not match when repository is missing", () => {
    const event: SCMWebhookEvent = {
      provider: "github",
      kind: "unknown",
      action: "noop",
      rawEventType: "unknown",
      data: {},
    };

    expect(eventMatchesProject(event, project)).toBe(false);
  });
});
