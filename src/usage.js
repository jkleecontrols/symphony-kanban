import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_MS = 10 * 1000;
const TAIL_BYTES = 128 * 1024;
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const LOOKBACK_DAYS = 35;
const CLAUDE_LIMITS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "claude-limits.json");

let cache = { at: 0, value: null };

// What is left before the next wall. Codex writes its real rate limits to its session
// log. Claude Code reports its plan limits only to its status line, so
// scripts/claude-limits.js saves them from there; until that has run, all there is to show
// for Claude is what the sessions cost.
export async function collectUsage(config, { force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;

  const [codex, claude] = await Promise.all([
    codexLimits().catch(() => null),
    claudeLimits().then((limits) => limits || claudeSpend(config?.usage?.budgets?.claude)).catch(() => null)
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
    windows.push(rolloverWindow(key, label, w));
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

// These numbers are a snapshot from the last session. If its window has since elapsed the
// allowance is back, so reporting the old figure would under-report what is available --
// and the reset time itself has to roll forward to the next one.
function rolloverWindow(key, label, w) {
  const minutes = Number.isFinite(w.window_minutes) ? w.window_minutes : null;
  let resetsAt = Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null;
  let used = w.used_percent;
  let expired = false;

  if (resetsAt && resetsAt <= Date.now()) {
    expired = true;
    used = 0;
    if (minutes) {
      const period = minutes * 60000;
      // Walk forward whole windows rather than guessing a single one.
      const steps = Math.ceil((Date.now() - resetsAt) / period);
      resetsAt += steps * period;
    } else {
      resetsAt = null;
    }
  }

  return {
    key,
    label: minutes ? windowLabel(minutes) : label,
    used_percent: round(used),
    remaining_percent: round(100 - used),
    window_minutes: minutes,
    resets_at: resetsAt ? new Date(resetsAt).toISOString() : null,
    expired
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

// ---------- Claude Code: the plan limits its status line was handed ----------

export async function claudeLimits(file = CLAUDE_LIMITS_FILE) {
  let saved;
  try {
    saved = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null; // the status line command is not set up, or has not run yet
  }

  const windows = [];
  for (const [key, label, minutes] of [["five_hour", "Session", 300], ["seven_day", "Weekly", 10080]]) {
    const w = saved?.rate_limits?.[key];
    if (!w || !Number.isFinite(w.used_percentage)) continue;
    windows.push(rolloverWindow(key, label, { used_percent: w.used_percentage, window_minutes: minutes, resets_at: w.resets_at }));
  }
  if (!windows.length) return null;

  return {
    id: "claude",
    label: "Claude Code",
    kind: "rate_limit",
    plan: null,
    remaining_percent: Math.min(...windows.map((w) => w.remaining_percent)),
    windows,
    measured_at: saved.at || null,
    note: null
  };
}

// ---------- Claude Code: spend, when no limits have been saved ----------

// Claude Code writes a session's cost only now and then -- a session still running may have
// none -- and stamps it with when the session began, which files a month-long session's
// spend under the day it was opened. So spend is rebuilt from the token counts on every
// assistant turn, at the time of that turn. The cost records are kept for one thing: what
// each model charges per token, which nothing else on disk says.
const OUTPUT_WEIGHT = 5;
const CACHE_READ_WEIGHT = 0.1;
const CACHE_WRITE_1H_WEIGHT = 2;
const CACHE_WRITE_5M_WEIGHT = 1.25;

// Transcripts run to tens of megabytes, so each is read once and then only where it grew.
const scans = new Map();

export async function claudeSpend(budget, { root = path.join(os.homedir(), ".claude", "projects"), now = Date.now() } = {}) {
  const files = await walk(root, (name) => name.endsWith(".jsonl"), Date.now() - LOOKBACK_DAYS * 86400000);
  if (!files.length) return null;

  // A message is written once per content block, and a resumed session repeats its
  // history in a new file, so turns are keyed by message id across every file.
  const turns = new Map();
  const billed = new Map();
  for (const file of files) {
    const scan = await scanTranscript(file.path).catch(() => null);
    if (!scan) continue;
    for (const [id, turn] of scan.turns) turns.set(id, turn);
    for (const [model, { cost, tokens }] of scan.billed) {
      const sum = billed.get(model) || { cost: 0, tokens: 0 };
      billed.set(model, { cost: sum.cost + cost, tokens: sum.tokens + tokens });
    }
  }

  const rates = new Map();
  for (const [model, { cost, tokens }] of billed) if (tokens > 0) rates.set(model, cost / tokens);
  if (!rates.size || !turns.size) return null;
  // A model with no cost record yet is priced as the dearest one seen, so the gauge errs
  // towards less left rather than more.
  const dearest = Math.max(...rates.values());

  const spend = { day: 0, week: 0, month: 0 };
  const sessions = new Set();
  let latest = 0;
  for (const turn of turns.values()) {
    const age = now - turn.at;
    if (age > LOOKBACK_DAYS * 86400000) continue;
    const cost = turn.tokens * (rates.get(turn.model) ?? dearest);
    sessions.add(turn.session);
    latest = Math.max(latest, turn.at);
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
      { key: "day", label: "24 hours", spend_usd: round(spend.day, 2), budget_usd: null, resets_at: null },
      { key: "week", label: "7 days", spend_usd: round(spend.week, 2), budget_usd: Number.isFinite(weekly) ? weekly : null, resets_at: null },
      { key: "month", label: "30 days", spend_usd: round(spend.month, 2), budget_usd: Number.isFinite(monthly) ? monthly : null, resets_at: null }
    ],
    sessions: sessions.size,
    measured_at: latest ? new Date(latest).toISOString() : null,
    note: ratios.length
      ? "Estimated from each turn's token counts, against the budget you declared, not a limit Claude reports."
      : "Claude Code records what a session cost but not your plan's ceiling, so there is no percentage to show. Set usage.budgets.claude in WORKFLOW.md for a gauge."
  };
}

async function scanTranscript(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    let scan = scans.get(filePath);
    if (!scan || size < scan.offset) {
      scan = { offset: 0, carry: Buffer.alloc(0), turns: new Map(), billed: new Map() };
      scans.set(filePath, scan);
    }
    while (scan.offset < size) {
      const buffer = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, size - scan.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, scan.offset);
      if (!bytesRead) break;
      scan.offset += bytesRead;
      const data = Buffer.concat([scan.carry, buffer.subarray(0, bytesRead)]);
      // Cut at the last newline: a line still being written waits for the next read.
      const cut = data.lastIndexOf(10) + 1;
      scan.carry = data.subarray(cut);
      for (const line of data.toString("utf8", 0, cut).split("\n")) readTranscriptLine(scan, line);
    }
    return scan;
  } finally {
    await handle.close();
  }
}

function readTranscriptLine(scan, line) {
  if (!line.includes('"assistant"') && !line.includes('"cost-state"')) return;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }

  if (record.type === "assistant") {
    const { id, model, usage } = record.message || {};
    const at = Date.parse(record.timestamp);
    if (!id || !usage || !Number.isFinite(at)) return;
    const write = usage.cache_creation;
    const cacheWrite = write
      ? count(write.ephemeral_1h_input_tokens) * CACHE_WRITE_1H_WEIGHT + count(write.ephemeral_5m_input_tokens) * CACHE_WRITE_5M_WEIGHT
      : count(usage.cache_creation_input_tokens) * CACHE_WRITE_1H_WEIGHT;
    scan.turns.set(id, {
      at,
      model,
      session: record.sessionId || null,
      tokens: count(usage.input_tokens) + count(usage.output_tokens) * OUTPUT_WEIGHT
        + count(usage.cache_read_input_tokens) * CACHE_READ_WEIGHT + cacheWrite
    });
  } else if (record.type === "cost-state" && record.modelUsage) {
    // Cumulative for the session, so the newest record replaces the one before it.
    scan.billed = new Map();
    for (const [model, used] of Object.entries(record.modelUsage)) {
      if (!Number.isFinite(used?.costUSD)) continue;
      scan.billed.set(model, {
        cost: used.costUSD,
        tokens: count(used.inputTokens) + count(used.outputTokens) * OUTPUT_WEIGHT
          + count(used.cacheReadInputTokens) * CACHE_READ_WEIGHT + count(used.cacheCreationInputTokens) * CACHE_WRITE_1H_WEIGHT
      });
    }
  }
}

function count(value) {
  return Number.isFinite(value) ? value : 0;
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

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
