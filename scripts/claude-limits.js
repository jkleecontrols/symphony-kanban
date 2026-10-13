#!/usr/bin/env node
// Claude Code's status line command. Claude Code hands every status line the plan limits
// it was last told about -- the same percentages its own usage screen shows -- and writes
// them nowhere on disk. This keeps the latest copy where the board can read it, then
// prints the line Claude Code displays.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "claude-limits.json");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let limits = null;
  try {
    limits = JSON.parse(input).rate_limits || null;
  } catch {
    // no payload, nothing to record
  }
  if (!limits) return;

  try {
    // Written beside the target and renamed, so the board never reads half a file.
    const scratch = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(scratch, JSON.stringify({ at: new Date().toISOString(), rate_limits: limits }));
    fs.renameSync(scratch, target);
  } catch {
    // the status line still has to print
  }

  const parts = [];
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "week"]]) {
    const used = limits[key]?.used_percentage;
    if (Number.isFinite(used)) parts.push(`${label} ${Math.round(used)}%`);
  }
  if (parts.length) process.stdout.write(`${parts.join(" · ")} used`);
});
