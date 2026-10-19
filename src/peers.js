import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Two sessions count as talking while a message has passed between them this recently.
export const TALK_WINDOW_MS = 15 * 60 * 1000;

// Names Claude Code picked itself. Anything else was set with /rename, and only a name
// that was chosen stays put long enough for another session to address it.
const UNCHOSEN = new Set(["auto", "derived"]);

// A name is typed into a terminal as `/rename <name>`, so it is held to characters that
// cannot end the line or start another command.
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,47}$/u;

// Claude Code keeps one file per running session, by pid: its name, where it came from,
// the conversation id and the socket other sessions reach it on.
export async function readClaudeRegistry(dir = path.join(os.homedir(), ".claude", "sessions")) {
  const found = new Map();
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return found;
  }
  await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    try {
      const entry = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
      if (!entry?.pid) return;
      found.set(String(entry.pid), {
        session_name: typeof entry.name === "string" ? entry.name : null,
        name_source: entry.nameSource || null,
        session_id: entry.sessionId || null
      });
    } catch {
      // a session writing its file as we read it; the next scan picks it up
    }
  }));
  return found;
}

// Codex appends a line to its index each time a thread is named; the last one wins.
export async function readCodexNames(file = path.join(os.homedir(), ".codex", "session_index.jsonl")) {
  const found = new Map();
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return found;
  }
  for (const line of text.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry?.id && entry.thread_name) found.set(entry.id, entry.thread_name);
    } catch {
      // a half-written last line
    }
  }
  return found;
}

export function isChosenName(source) {
  return Boolean(source) && !UNCHOSEN.has(source);
}

export function validSessionName(value) {
  const name = String(value ?? "").trim();
  return NAME_PATTERN.test(name) ? name : null;
}

// Who this session has exchanged messages with, newest first. A message in arrives as a
// user turn, or a queued one while it was busy, wrapped in
// <cross-session-message from-name="...">; one going out is a SendMessage call
// addressed `to` a name.
export function peersIn(records, now = Date.now(), windowMs = TALK_WINDOW_MS) {
  const latest = new Map();
  const note = (name, at, direction) => {
    const when = Date.parse(at || "");
    if (!name || !Number.isFinite(when) || now - when > windowMs) return;
    const seen = latest.get(name);
    if (!seen || seen.when < when) latest.set(name, { name, at, when, direction });
  };
  for (const record of records) {
    const content = record?.message?.content;
    if (record?.type === "user" || record?.type === "queue-operation") {
      const text = record.type === "queue-operation"
        ? String(record.content ?? "")
        : typeof content === "string"
          ? content
          : Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";
      for (const match of text.matchAll(/<cross-session-message\b[^>]*\bfrom-name="([^"]+)"/g)) note(match[1], record.timestamp, "in");
    } else if (record?.type === "assistant" && Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "tool_use" && part.name === "SendMessage" && typeof part.input?.to === "string") {
          note(part.input.to, record.timestamp, "out");
        }
      }
    }
  }
  return [...latest.values()].sort((a, b) => b.when - a.when).map(({ name, at, direction }) => ({ name, at, direction }));
}

// A skill is pasted as a GitHub link: a repository, a folder in it, or its SKILL.md.
export function validSkillUrl(value) {
  const text = String(value ?? "").trim();
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/[\w.%~/-]*)?$/.test(text) ? text : null;
}

// What is typed into a session to take a skill on. The session fetches it itself, so the
// same words work for Claude Code and Codex, each installing where its own CLI looks.
export function skillPrompt(url) {
  return `Install the agent skill at ${url} for this project: fetch its SKILL.md and any files beside it into the skills folder your CLI reads (.claude/skills/<name>/ for Claude Code, .agents/skills/<name>/ for Codex), then confirm its name in one line and apply it to the work here from now on.`;
}
