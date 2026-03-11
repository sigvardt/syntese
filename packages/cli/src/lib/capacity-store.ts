/**
 * Per-account capacity tracking.
 *
 * Persists consumed-message counts and overage data per account.
 * Storage: ~/.syntese/accounts/<accountId>/capacity.json
 *
 * Accounts are either explicitly configured under `accounts:` in syntese.yaml,
 * or implicitly derived from the agent types used across projects (one default
 * account per agent type, named after the agent).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  getAccountCapacityFile,
  type AccountCapacity,
  type AccountCapacityStatus,
  type AccountConfig,
  type AccountOverage,
  type OrchestratorConfig,
} from "@syntese/core";

// ─── Persisted State ─────────────────────────────────────────────────────────

const CAPACITY_STATE_VERSION = 1;

/** Persisted self-tracked state for one account. */
export interface AccountCapacityState {
  version: number;
  accountId: string;
  /** Number of sessions spawned since window start. */
  consumed: number;
  /** ISO timestamp when the current window started (first spawn). */
  windowStartedAt: string | null;
  /** Dollars or credits consumed in overage this window. */
  overageConsumed: number;
  /** Last update timestamp. */
  updatedAt: string;
}

function defaultState(accountId: string): AccountCapacityState {
  return {
    version: CAPACITY_STATE_VERSION,
    accountId,
    consumed: 0,
    windowStartedAt: null,
    overageConsumed: 0,
    updatedAt: new Date().toISOString(),
  };
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

export async function readCapacityState(accountId: string): Promise<AccountCapacityState> {
  const filePath = getAccountCapacityFile(accountId);
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      "accountId" in parsed
    ) {
      return parsed as AccountCapacityState;
    }
    return defaultState(accountId);
  } catch {
    return defaultState(accountId);
  }
}

export async function writeCapacityState(state: AccountCapacityState): Promise<void> {
  const filePath = getAccountCapacityFile(state.accountId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

// ─── Spawn Tracking ───────────────────────────────────────────────────────────

/**
 * Increment consumed count for an account when a session is spawned.
 * Starts the window clock if this is the first spawn.
 */
export async function incrementAccountConsumed(accountId: string): Promise<void> {
  const state = await readCapacityState(accountId);
  const now = new Date().toISOString();

  state.consumed += 1;
  state.updatedAt = now;
  if (!state.windowStartedAt) {
    state.windowStartedAt = now;
  }

  await writeCapacityState(state);
}

/**
 * Calibrate consumed count from an external source (e.g. /status command output).
 * If calibration shows less remaining than self-tracked, trust calibration.
 */
export async function calibrateAccountConsumed(
  accountId: string,
  externalConsumed: number,
): Promise<void> {
  const state = await readCapacityState(accountId);
  // Trust the higher consumed count (external usage may have occurred outside Syntese)
  if (externalConsumed > state.consumed) {
    state.consumed = externalConsumed;
    state.updatedAt = new Date().toISOString();
    await writeCapacityState(state);
  }
}

// ─── Capacity Computation ─────────────────────────────────────────────────────

/** Format milliseconds as "Xh Ym" or "Ym" */
function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function computeWindowResetIn(
  windowStartedAt: string | null,
  windowHours: number,
): string | null {
  if (!windowStartedAt) return null;
  const startMs = new Date(windowStartedAt).getTime();
  const windowMs = windowHours * 3600_000;
  const resetAt = startMs + windowMs;
  const remaining = resetAt - Date.now();
  if (remaining <= 0) return "now";
  return formatDuration(remaining);
}

function computeStatus(
  percentRemaining: number,
  overage: AccountOverage | null,
): AccountCapacityStatus {
  const hasQuota = percentRemaining > 0;
  const hasOverage = overage !== null && overage.enabled && overage.remaining > 0;

  if (hasQuota) return "available";
  if (!hasQuota && hasOverage) return "overage-only";
  if (!hasQuota && !hasOverage) return "fully-exhausted";
  return "quota-exhausted";
}

/**
 * Compute the real-time AccountCapacity from config, persisted state, and
 * a live active-session count.
 */
export function computeAccountCapacity(
  accountId: string,
  config: AccountConfig,
  state: AccountCapacityState,
  activeSessions: number,
): AccountCapacity {
  const windowHours = config.baseQuota?.windowHours ?? 5;
  const estimatedTotal = config.baseQuota?.estimatedTotal ?? 0;

  // Check if window has expired; if so, treat consumed as 0 for display
  let effectiveConsumed = state.consumed;
  if (state.windowStartedAt) {
    const windowMs = windowHours * 3600_000;
    const elapsed = Date.now() - new Date(state.windowStartedAt).getTime();
    if (elapsed >= windowMs) {
      effectiveConsumed = 0;
    }
  }

  const remaining = Math.max(0, estimatedTotal - effectiveConsumed);
  const percentRemaining =
    estimatedTotal > 0 ? Math.round((remaining / estimatedTotal) * 100) : 100;

  const baseQuota = {
    estimatedTotal,
    consumed: effectiveConsumed,
    remaining,
    percentRemaining,
    windowResetIn: computeWindowResetIn(state.windowStartedAt, windowHours),
  };

  let overage: AccountOverage | null = null;
  if (config.overage?.enabled) {
    const spendCap = config.overage.spendCap ?? 0;
    const overageConsumed = state.overageConsumed;
    overage = {
      enabled: true,
      type: config.overage.type ?? "credits",
      consumed: overageConsumed,
      spendCap,
      remaining: Math.max(0, spendCap - overageConsumed),
    };
  }

  const status = computeStatus(percentRemaining, overage);

  return {
    accountId,
    agent: config.agent,
    model: config.model ?? null,
    baseQuota,
    overage,
    activeSessions,
    status,
  };
}

// ─── Account Derivation ───────────────────────────────────────────────────────

/**
 * Get all account configs: explicit ones from config.accounts plus implicit
 * defaults derived from agent types used across projects.
 *
 * Implicit accounts use the agent name as both the accountId and agent field,
 * with no quota limits (everything shows as "available" with no estimatedTotal).
 */
export function getEffectiveAccounts(config: OrchestratorConfig): Record<string, AccountConfig> {
  const explicit = config.accounts ?? {};

  // Derive implicit accounts from project agents not already covered
  const agentsCovered = new Set(Object.values(explicit).map((a) => a.agent));

  const implicit: Record<string, AccountConfig> = {};
  for (const project of Object.values(config.projects)) {
    const agentName = project.agent ?? config.defaults.agent;
    if (!agentsCovered.has(agentName)) {
      // Use agent name as accountId for the implicit default
      implicit[agentName] = { agent: agentName };
      agentsCovered.add(agentName);
    }
  }

  return { ...implicit, ...explicit };
}

/**
 * Resolve which accountId to use when spawning a session for a project.
 * Prefers explicit account matching; falls back to agent-named default.
 */
export function resolveAccountForProject(
  config: OrchestratorConfig,
  projectId: string,
): string {
  const project = config.projects[projectId];
  const agentName = project?.agent ?? config.defaults.agent;

  // If an explicit account uses this agent, pick the first match
  if (config.accounts) {
    for (const [accountId, accountConfig] of Object.entries(config.accounts)) {
      if (accountConfig.agent === agentName) {
        return accountId;
      }
    }
  }

  // Fall back to the implicit agent-named account
  return agentName;
}
