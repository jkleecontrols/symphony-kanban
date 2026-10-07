import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CACHE_MS = 60 * 1000;
const TAIL_BYTES = 128 * 1024;
const LOOKBACK_DAYS = 35;

let cache = { at: 0, value: null };

// What is left before the next wall. Codex publishes real rate limits; Claude Code
// records what a session cost but never what the ceiling is, so there the only honest
// gauge is against a budget the operator declares.
export async function collectUsage(config, { force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;

  const [codex, claude] = await Promise.all([
    codexLimits().catch(() => null),
    claudeSpend(config?.usage?.budgets?.claude).catch(() => null)
  ]);

  const sources = [codex, claude].filter(Boolean);
  const measured = sources.map((s) => s.remaining_percent).filter((n) => Number.isFinite(n));
  const value = {
    at: new Date().toISOString(),
    // The battery shows the tightest constraint: the one that stops you first.
    remaining_percent: measured.length ? Math.min(...measured) : null,
    sources
  };
  cache = { at: Date.now(), value };
  return value;
}

// ---------- Codex: real rate limits, straight from its own session log ----------

async function codexLimits() {
  const file = await newestCodexRollout();
  if (!file) return null;
  const payload = await lastTokenCount(file);
  const limits = payload?.rate_limits;
  if (!limits) return null;

  const windows = [];
  for (const [key, label] of [["primary", "Session"], ["secondary", "Weekly"]]) {
    const w = limits[key];
    if (!w || !Number.isFinite(w.used_percent)) continue;
    windows.push({
      key,
      label: w.window_minutes ? windowLabel(w.window_minutes) : label,
      used_percent: round(w.used_percent),
      remaining_percent: round(100 - w.used_percent),
      window_minutes: w.window_minutes ?? null,
      resets_at: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null
    });
  }
  if (!windows.length) return null;

  const usage = payload.info?.total_token_usage || {};
  return {
    id: "codex",
    label: "Codex",
    kind: "rate_limit",
    plan: limits.plan_type || null,
    remaining_percent: Math.min(...windows.map((w) => w.remaining_percent)),
    windows,
    tokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null,
    measured_at: payload.__at || null,
    note: null
  };
}

async function newestCodexRollout() {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const files = await walk(root, (name) => name.endsWith(".jsonl"), Date.now() - LOOKBACK_DAYS * 86400000);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

async function lastTokenCount(file) {
  let found = null;
  for (const record of await tailRecords(file.path)) {
    const payload = record?.payload;
    if (payload && typeof payload === "object" && payload.type === "token_count") {
      found = { ...payload, __at: record.timestamp || null };
    }
  }
  return found;
}

// ---------- Claude Code: spend only, so a declared budget is the yardstick ----------

async function claudeSpend(budget) {
  const root = path.join(os.homedir(), ".claude", "projects");
  const files = await walk(root, (name) => name.endsWith(".jsonl"), Date.now() - LOOKBACK_DAYS * 86400000, 2);
  if (!files.length) return null;

  // One cost-state per session, rewritten as it grows; the last one is that session's total.
  const sessions = new Map();
  for (const file of files) {
    for (const record of await tailRecords(file.path)) {
      if (record?.type !== "cost-state" || !Number.isFinite(record.totalCostUSD)) continue;
      sessions.set(record.sessionId || file.path, {
        cost: record.totalCostUSD,
        startedAt: Number.isFinite(record.startTime) ? record.startTime : file.mtimeMs
      });
    }
  }
  if (!sessions.size) return null;

  const now = Date.now();
  const spend = { day: 0, week: 0, month: 0, total: 0 };
  for (const { cost, startedAt } of sessions.values()) {
    spend.total += cost;
    const age = now - startedAt;
    if (age <= 86400000) spend.day += cost;
    if (age <= 7 * 86400000) spend.week += cost;
    if (age <= 30 * 86400000) spend.month += cost;
  }

  const weekly = Number(budget?.weekly_usd);
  const monthly = Number(budget?.monthly_usd);
  const ratios = [];
  if (Number.isFinite(weekly) && weekly > 0) ratios.push(spend.week / weekly);
  if (Number.isFinite(monthly) && monthly > 0) ratios.push(spend.month / monthly);

  return {
    id: "claude",
    label: "Claude Code",
    kind: ratios.length ? "budget" : "spend_only",
    plan: null,
    remaining_percent: ratios.length ? round(Math.max(0, 100 - Math.max(...ratios) * 100)) : null,
    windows: [
      { key: "day", label: "Today", spend_usd: round(spend.day, 2), budget_usd: null, resets_at: endOfDay() },
      { key: "week", label: "7 days", spend_usd: round(spend.week, 2), budget_usd: Number.isFinite(weekly) ? weekly : null, resets_at: null },
      { key: "month", label: "30 days", spend_usd: round(spend.month, 2), budget_usd: Number.isFinite(monthly) ? monthly : null, resets_at: null }
    ],
    sessions: sessions.size,
    note: ratios.length
      ? "Measured against the budget you declared, not a limit Claude reports."
      : "Claude Code records what a session cost but not your plan's ceiling, so there is no percentage to show. Set usage.budgets.claude in WORKFLOW.md for a gauge."
  };
}

// ---------- shared ----------

async function walk(dir, accept, cutoffMs, depth = 4) {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await walk(full, accept, cutoffMs, depth - 1));
    } else if (accept(entry.name)) {
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs >= cutoffMs) found.push({ path: full, mtimeMs: stat.mtimeMs });
      } catch {
        // raced with a delete
      }
    }
  }
  return found;
}

async function tailRecords(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(TAIL_BYTES, size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (size > length) lines.shift();
    const records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // a partially written last line
      }
    }
    return records;
  } finally {
    await handle.close();
  }
}

function windowLabel(minutes) {
  if (minutes % 10080 === 0) return `${minutes / 10080} week${minutes === 10080 ? "" : "s"}`;
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} min`;
}

function endOfDay() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
