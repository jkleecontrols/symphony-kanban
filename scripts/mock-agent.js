#!/usr/bin/env node

import fs from "node:fs/promises";

const prompt = process.env.SYMPHONY_PROMPT || "";
const issue = process.env.SYMPHONY_ISSUE_IDENTIFIER || "unknown";
const turn = process.env.SYMPHONY_TURN || "1";

console.log(JSON.stringify({
  type: "codex_event",
  event: "turn_started",
  issue,
  turn,
  message: `received ${prompt.length} prompt characters`
}));

await new Promise((resolve) => setTimeout(resolve, 400));

console.log(JSON.stringify({
  type: "codex_event",
  event: "turn_completed",
  issue,
  turn,
  input_tokens: Math.ceil(prompt.length / 4),
  output_tokens: 80,
  message: "mock agent completed one turn"
}));

if (turn === "3" && process.env.SYMPHONY_TRACKER_KIND === "local_json" && process.env.SYMPHONY_TRACKER_PATH) {
  await withFileLock(`${process.env.SYMPHONY_TRACKER_PATH}.lock`, async () => {
    const source = await fs.readFile(process.env.SYMPHONY_TRACKER_PATH, "utf8");
    const issues = JSON.parse(source);
    const target = issues.find((item) => item.id === process.env.SYMPHONY_ISSUE_ID);
    if (target) {
      target.state = "Done";
      target.dispatchable = false;
      target.updated_at = new Date().toISOString();
      await fs.writeFile(process.env.SYMPHONY_TRACKER_PATH, `${JSON.stringify(issues, null, 2)}\n`);
      console.log(JSON.stringify({
        type: "codex_event",
        event: "tracker_updated",
        issue,
        turn,
        message: "mock agent moved issue to Done"
      }));
    }
  });
}

async function withFileLock(lockPath, fn) {
  let handle = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await fs.open(lockPath, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!handle) throw new Error(`could not acquire lock ${lockPath}`);
  try {
    await fn();
  } finally {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  }
}
