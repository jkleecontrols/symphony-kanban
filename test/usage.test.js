import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeLimits, claudeSpend } from "../src/usage.js";

const DAY = 86400000;
const NOW = Date.parse("2026-10-13T20:00:00Z");

async function projectDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-usage-"));
  await fs.mkdir(path.join(root, "proj"));
  return root;
}

function turn(id, at, usage, { model = "claude-opus-5", sessionId = "s1" } = {}) {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp: new Date(at).toISOString(),
    message: { id, model, usage }
  });
}

// $5 per million input tokens, which is what makes a million input tokens cost $5 below.
function costState(sessionId, startTime, { model = "claude-opus-5", inputTokens = 1e6, costUSD = 5 } = {}) {
  return JSON.stringify({
    type: "cost-state",
    sessionId,
    totalCostUSD: costUSD,
    startTime,
    modelUsage: {
      [model]: { inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD }
    }
  });
}

const write = (root, name, lines) => fs.writeFile(path.join(root, "proj", name), lines.join("\n") + "\n");
const spendOf = (result, key) => result.windows.find((w) => w.key === key).spend_usd;

test("a session started weeks ago counts today's turns as today's spend", async () => {
  const root = await projectDir();
  await write(root, "s1.jsonl", [
    turn("m1", NOW - 20 * DAY, { input_tokens: 1e6, output_tokens: 0 }),
    turn("m2", NOW - 3600000, { input_tokens: 2e6, output_tokens: 0 }),
    costState("s1", NOW - 20 * DAY, { inputTokens: 3e6, costUSD: 15 })
  ]);

  const result = await claudeSpend(null, { root, now: NOW });
  assert.equal(spendOf(result, "day"), 10);
  assert.equal(spendOf(result, "week"), 10);
  assert.equal(spendOf(result, "month"), 15);
});

test("a session still running, with no cost record yet, is counted", async () => {
  const root = await projectDir();
  await write(root, "old.jsonl", [
    turn("m1", NOW - 10 * DAY, { input_tokens: 1e6, output_tokens: 0 }, { sessionId: "old" }),
    costState("old", NOW - 10 * DAY)
  ]);
  await write(root, "live.jsonl", [
    turn("m2", NOW - 60000, { input_tokens: 0, output_tokens: 1e6 }, { sessionId: "live" })
  ]);

  const result = await claudeSpend(null, { root, now: NOW });
  // Output is priced at five times input: 1M output tokens at a $5/M input rate.
  assert.equal(spendOf(result, "day"), 25);
  assert.equal(result.sessions, 2);
});

test("one message written as several records is counted once", async () => {
  const root = await projectDir();
  await write(root, "s1.jsonl", [
    turn("m1", NOW - 60000, { input_tokens: 1e6, output_tokens: 0 }),
    turn("m1", NOW - 60000, { input_tokens: 1e6, output_tokens: 0 }),
    costState("s1", NOW - DAY / 2)
  ]);

  const result = await claudeSpend(null, { root, now: NOW });
  assert.equal(spendOf(result, "day"), 5);
});

test("turns appended after the first read show up on the next one", async () => {
  const root = await projectDir();
  await write(root, "s1.jsonl", [
    turn("m1", NOW - 120000, { input_tokens: 1e6, output_tokens: 0 }),
    costState("s1", NOW - DAY / 2)
  ]);
  assert.equal(spendOf(await claudeSpend(null, { root, now: NOW }), "day"), 5);

  await fs.appendFile(
    path.join(root, "proj", "s1.jsonl"),
    turn("m2", NOW - 1000, { input_tokens: 1e6, output_tokens: 0 }) + "\n"
  );
  assert.equal(spendOf(await claudeSpend(null, { root, now: NOW }), "day"), 10);
});

test("cache reads and writes are priced at their own rates", async () => {
  const root = await projectDir();
  await write(root, "s1.jsonl", [
    turn("m1", NOW - 60000, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1e6,
      cache_creation_input_tokens: 2e6,
      cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 1e6 }
    }),
    costState("s1", NOW - DAY / 2)
  ]);

  const result = await claudeSpend(null, { root, now: NOW });
  // 0.1x for a read, 2x for an hour-long write, 1.25x for a five-minute one, at $5/M.
  assert.equal(spendOf(result, "day"), 0.5 + 10 + 6.25);
});

async function limitsFile(rate_limits) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-limits-"));
  const file = path.join(root, "claude-limits.json");
  await fs.writeFile(file, JSON.stringify({ at: "2026-10-13T21:24:53.282Z", rate_limits }));
  return file;
}

test("Claude's plan limits are reported as the percentages Claude Code was given", async () => {
  const later = Math.floor(Date.now() / 1000) + 3600;
  const file = await limitsFile({
    five_hour: { used_percentage: 48, resets_at: later },
    seven_day: { used_percentage: 5, resets_at: later }
  });

  const result = await claudeLimits(file);
  assert.equal(result.kind, "rate_limit");
  assert.equal(result.remaining_percent, 52);
  assert.deepEqual(result.windows.map((w) => [w.label, w.used_percent]), [["5 hours", 48], ["1 week", 5]]);
  assert.equal(result.measured_at, "2026-10-13T21:24:53.282Z");
});

test("a session window that has reset since it was saved reads as unused", async () => {
  const now = Math.floor(Date.now() / 1000);
  const file = await limitsFile({
    five_hour: { used_percentage: 90, resets_at: now - 60 },
    seven_day: { used_percentage: 5, resets_at: now + 3600 }
  });

  const result = await claudeLimits(file);
  assert.equal(result.windows[0].used_percent, 0);
  assert.equal(result.remaining_percent, 95);
});

test("with no saved limits there is nothing to report", async () => {
  assert.equal(await claudeLimits(path.join(os.tmpdir(), "symphony-no-such-limits.json")), null);
});
