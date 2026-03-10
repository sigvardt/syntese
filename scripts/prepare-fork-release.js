import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = /^v\d+\.\d+\.\d+-sigvardt\.\d+$/u;
const RELEASE_HEADING_PREFIX = "## [";

const version = process.argv[2];

if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
  throw new Error("Expected a version like v0.1.0-sigvardt.1.");
}

const repoRoot = resolve(fileURLToPath(new globalThis.URL("..", import.meta.url)));
const versionFile = resolve(repoRoot, "FORK_VERSION");
const changelogFile = resolve(repoRoot, "FORK_CHANGELOG.md");

const changelog = readFileSync(changelogFile, "utf8").trimEnd();
const releaseHeading = `${RELEASE_HEADING_PREFIX}${version}]`;

writeFileSync(versionFile, `${version}\n`);

if (changelog.includes(releaseHeading)) {
  console.log(`Release ${version} already exists in FORK_CHANGELOG.md; skipping entry generation.`);
  process.exit(0);
}

const lastForkTag = getLastForkTag();

if (lastForkTag === null) {
  throw new Error(
    `No previous fork tag found. Seed ${releaseHeading} in FORK_CHANGELOG.md before the first tagged release.`,
  );
}

const commits = getCommitSubjects(`${lastForkTag}..HEAD`)
  .map(parseConventionalCommit)
  .filter((entry) => entry !== null);

if (commits.length === 0) {
  throw new Error(`No conventional commits found since ${lastForkTag}.`);
}

const nextChangelog = insertReleaseEntry(
  changelog,
  renderReleaseEntry(version, new Date().toISOString().slice(0, 10), commits),
);

writeFileSync(changelogFile, `${nextChangelog}\n`);
console.log(`Updated FORK_VERSION and FORK_CHANGELOG.md for ${version}.`);

function getLastForkTag() {
  try {
    return execFileSync(
      "git",
      ["describe", "--tags", "--abbrev=0", "--match", "v*-sigvardt.*"],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim();
  } catch {
    return null;
  }
}

function getCommitSubjects(range) {
  return execFileSync(
    "git",
    ["log", "--reverse", "--no-merges", "--format=%s", range],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\n")
    .map((subject) => subject.trim())
    .filter((subject) => subject.length > 0);
}

function parseConventionalCommit(subject) {
  const match = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?:!)?: (?<description>.+)$/u.exec(subject);

  if (match === null || match.groups === undefined) {
    return null;
  }

  const type = match.groups.type.toLowerCase();
  const scope = match.groups.scope?.trim();
  const description = match.groups.description
    .replace(/\s+\(#\d+\)$/u, "")
    .replace(/\s+\[skip ci\]$/iu, "")
    .trim();

  if (type === "chore" && scope === "release") {
    return null;
  }

  const normalized = scope === undefined ? description : `${scope}: ${description}`;
  const section = type === "feat" ? "Added" : type === "fix" ? "Fixed" : "Changed";

  return { section, description: normalized };
}

function renderReleaseEntry(versionValue, releaseDate, commits) {
  const sectionOrder = ["Added", "Changed", "Fixed"];
  const grouped = new Map(sectionOrder.map((section) => [section, []]));

  for (const commit of commits) {
    grouped.get(commit.section)?.push(commit.description);
  }

  const uniqueSections = sectionOrder.flatMap((section) => {
    const entries = Array.from(new Set(grouped.get(section)));

    if (entries.length === 0) {
      return [];
    }

    return [
      `### ${section}`,
      ...entries.map((entry) => `- ${entry}`),
      "",
    ];
  });

  return [`## [${versionValue}] - ${releaseDate}`, "", ...uniqueSections].join("\n").trimEnd();
}

function insertReleaseEntry(existingChangelog, releaseEntry) {
  const unreleasedHeading = `${RELEASE_HEADING_PREFIX}Unreleased]`;
  const unreleasedIndex = existingChangelog.indexOf(unreleasedHeading);

  if (unreleasedIndex === -1) {
    throw new Error("FORK_CHANGELOG.md must include an [Unreleased] section.");
  }

  const nextReleaseIndex = existingChangelog.indexOf(`\n${RELEASE_HEADING_PREFIX}`, unreleasedIndex + unreleasedHeading.length);

  if (nextReleaseIndex === -1) {
    return `${existingChangelog.trimEnd()}\n\n${releaseEntry}`;
  }

  const head = existingChangelog.slice(0, nextReleaseIndex).trimEnd();
  const tail = existingChangelog.slice(nextReleaseIndex).trimStart();

  return `${head}\n\n${releaseEntry}\n\n${tail}`;
}
