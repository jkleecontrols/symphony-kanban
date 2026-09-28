import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TAIL_BYTES = 96 * 1024;
const CODEX_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_TEXT = 160;
// A turn that ended moments ago is still "working" as far as an operator is concerned.
const WORKING_GRACE_MS = 45 * 1000;
const HISTORY_CACHE_MS = 15 * 1000;

const historyCache = new Map();

// What a running session is actually doing. Both CLIs keep an append-only JSONL
// transcript; reading its tail is how the board reports live work it did not start.
export async function readActivity(session, roots = {}) {
  try {
    if (session.name === "claude") return await claudeActivity(session.cwd, roots.claude);
    if (session.name === "codex") return await codexActivity(session.cwd);
  } catch {
    // A transcript that cannot be read just means no detail for this card.
  }
  return null;
}

async function claudeActivity(cwd, root) {
  const dir = await claudeProjectDir(cwd, root);
  if (!dir) return null;
  const file = await newestFile(dir, (name) => name.endsWith(".jsonl"));
  if (!file) return null;

  const records = await tailRecords(file.path);
  let title = null;
  let activity = null;
  let at = null;
  let stopReason = null;
  let lastText = "";

  for (const record of records) {
    if (record.type === "ai-title" && record.aiTitle) title = String(record.aiTitle);
    if (record.timestamp) at = record.timestamp;
    if (record.type !== "assistant") continue;
    if (record.message?.stop_reason) stopReason = record.message.stop_reason;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "text" && part.text?.trim()) {
        activity = clip(part.text.trim());
        lastText = part.text.trim();
      } else if (part?.type === "tool_use" && part.name) {
        activity = `using ${part.name}`;
        lastText = "";
      }
    }
  }

  const when = at || file.mtime;
  return { title, activity, at: when, phase: phaseOf(stopReason, lastText, when), transcript: file.path };
}

// Claude Code names a project folder after its path with every character outside
// [A-Za-z0-9-] replaced by a dash -- dots and underscores included, which a slash-only
// rule silently misses. When that guess does not exist, fall back to asking the
// transcripts themselves which folder they belong to, so a change to the naming rule
// degrades into a slower lookup rather than an empty card.
export async function claudeProjectDir(cwd, rootOverride) {
  const root = rootOverride || path.join(os.homedir(), ".claude", "projects");
  const guess = path.join(root, cwd.replace(/[^A-Za-z0-9-]/g, "-"));
  if (await isDirectory(guess)) return guess;

  let names;
  try {
    names = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const name of names) {
    const candidate = path.join(root, name);
    const file = await newestFile(candidate, (entry) => entry.endsWith(".jsonl"));
    if (!file) continue;
    const [first] = await tailRecords(file.path, 8 * 1024, "head");
    if (first?.cwd === cwd) return candidate;
  }
  return null;
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
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
    let phase = "idle";
    for (const record of tail) {
      if (record.timestamp) at = record.timestamp;
      const payload = record.payload;
      if (!payload || typeof payload !== "object") continue;
      if (payload.type === "task_started") { activity = "working on a turn"; phase = "working"; }
      else if (payload.type === "task_complete") { activity = "turn finished"; phase = "idle"; }
      else if (payload.type === "message" && payload.role === "assistant") {
        const text = textOf(payload.content);
        if (text) activity = clip(text);
      }
    }
    const when = at || file.mtime;
    if (phase === "idle" && Date.now() - Date.parse(when) < WORKING_GRACE_MS) phase = "working";
    return { title: null, activity, at: when, phase, transcript: file.path };
  }
  return null;
}

// Claude records why the assistant stopped: mid-turn tool calls mean it is working,
// end_turn means it handed control back and is waiting on the person.
export function phaseOf(stopReason, lastText, at) {
  const quietFor = Date.now() - Date.parse(at || "");
  if (stopReason === "tool_use") return "working";
  if (stopReason !== "end_turn") {
    return Number.isFinite(quietFor) && quietFor < WORKING_GRACE_MS ? "working" : "idle";
  }
  if (Number.isFinite(quietFor) && quietFor < WORKING_GRACE_MS) return "working";
  return looksLikeAQuestion(lastText) ? "waiting" : "idle";
}

// The one judgement call here: a finished turn that asks something is waiting on an
// answer, while one that simply reports is idle. Text is all there is to go on.
export function looksLikeAQuestion(text) {
  const tail = String(text || "").replace(/\s+/g, " ").trim().slice(-320);
  if (!tail) return false;
  if (/[?？]\s*$/.test(tail)) return true;
  if (/[?？]/.test(tail.slice(-160))) return true;
  return /(까요|link|을까|ㄹ까|나요|가요|주세요|해 ?주시|알려ㅤ?주|골라|선택해|어느 ?쪽|괜찮을까|진행할까|맞나요)\s*[.!]?\s*$/.test(tail);
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

// Whether a folder has ever been worked in, and when. Unlike a live process this
// survives a restart, so a card whose session ended while Symphony was down is still
// recognised as finished rather than frozen wherever it was left.
export async function lastActivity(cwd, names = ["claude", "codex"]) {
  const key = `${cwd}\u0000${names.join(",")}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_CACHE_MS) return hit.value;

  let best = null;
  for (const name of names) {
    const activity = await readActivity({ name, cwd });
    if (activity?.at && (!best || activity.at > best.at)) best = { ...activity, name };
  }
  historyCache.set(key, { at: Date.now(), value: best });
  return best;
}
