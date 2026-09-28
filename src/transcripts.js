import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TAIL_BYTES = 96 * 1024;
const CODEX_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_TEXT = 160;

// What a running session is actually doing. Both CLIs keep an append-only JSONL
// transcript; reading its tail is how the board reports live work it did not start.
export async function readActivity(session) {
  try {
    if (session.name === "claude") return await claudeActivity(session.cwd);
    if (session.name === "codex") return await codexActivity(session.cwd);
  } catch {
    // A transcript that cannot be read just means no detail for this card.
  }
  return null;
}

async function claudeActivity(cwd) {
  const dir = path.join(os.homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
  const file = await newestFile(dir, (name) => name.endsWith(".jsonl"));
  if (!file) return null;

  const records = await tailRecords(file.path);
  let title = null;
  let activity = null;
  let at = null;

  for (const record of records) {
    if (record.type === "ai-title" && record.aiTitle) title = String(record.aiTitle);
    if (record.timestamp) at = record.timestamp;
    if (record.type !== "assistant") continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "text" && part.text?.trim()) activity = clip(part.text.trim());
      else if (part?.type === "tool_use" && part.name) activity = `using ${part.name}`;
    }
  }

  return { title, activity, at: at || file.mtime, transcript: file.path };
}

async function codexActivity(cwd) {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const cutoff = Date.now() - CODEX_WINDOW_MS;
  const files = (await walkJsonl(root, cutoff)).sort((a, b) => b.mtime.localeCompare(a.mtime));

  for (const file of files.slice(0, 40)) {
    const records = await tailRecords(file.path, 8 * 1024, "head");
    const meta = records.find((record) => record.type === "session_meta");
    if (meta?.payload?.cwd !== cwd) continue;

    const tail = await tailRecords(file.path);
    let activity = null;
    let at = null;
    for (const record of tail) {
      if (record.timestamp) at = record.timestamp;
      const payload = record.payload;
      if (!payload || typeof payload !== "object") continue;
      if (payload.type === "task_started") activity = "working on a turn";
      else if (payload.type === "task_complete") activity = "turn finished";
      else if (payload.type === "message" && payload.role === "assistant") {
        const text = textOf(payload.content);
        if (text) activity = clip(text);
      }
    }
    return { title: null, activity, at: at || file.mtime, transcript: file.path };
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join(" ").trim();
}

function clip(text) {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
}

async function newestFile(dir, accept) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const files = [];
  for (const name of names) {
    if (!accept(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (stat.isFile()) files.push({ path: full, mtime: stat.mtime.toISOString() });
    } catch {
      // raced with a delete
    }
  }
  return files.sort((a, b) => b.mtime.localeCompare(a.mtime))[0] || null;
}

async function walkJsonl(dir, cutoffMs, depth = 0) {
  if (depth > 4) return [];
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
      found.push(...await walkJsonl(full, cutoffMs, depth + 1));
    } else if (entry.name.endsWith(".jsonl")) {
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs >= cutoffMs) found.push({ path: full, mtime: stat.mtime.toISOString() });
      } catch {
        // raced with a delete
      }
    }
  }
  return found;
}

// Read only the end (or start) of a transcript; these files grow without bound.
async function tailRecords(filePath, bytes = TAIL_BYTES, from = "tail") {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(bytes, size);
    const position = from === "head" ? 0 : size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    const lines = buffer.toString("utf8").split("\n");
    if (from !== "head" && position > 0) lines.shift();
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
