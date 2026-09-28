import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPEAT_AFTER_MS = 30 * 60 * 1000;

// The board is passive: it reports correctly, but only to someone looking at it. With
// several folders in flight the scarce thing is attention, so the machine says when it
// needs you rather than waiting to be checked on.
export class Notifier {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.sent = new Map();
  }

  async send(event, { title, message, key }) {
    const settings = this.config.notify;
    if (!settings.enabled) return false;
    if (settings.on.length && !settings.on.includes(event)) return false;

    // The same card waiting on the same answer should not nag on every poll.
    const dedupeKey = `${event}:${key}`;
    const last = this.sent.get(dedupeKey);
    if (last && Date.now() - last < REPEAT_AFTER_MS) return false;
    this.sent.set(dedupeKey, Date.now());

    try {
      await deliver(settings.command, title, message);
      this.logger.event("info", "notified", { event, key, title });
      return true;
    } catch (error) {
      this.logger.event("warn", "notify_failed", { event, key, error: error.message });
      return false;
    }
  }

  // Once a card moves on, the next time it needs attention is worth saying again.
  forget(key) {
    for (const entry of [...this.sent.keys()]) {
      if (entry.endsWith(`:${key}`)) this.sent.delete(entry);
    }
  }
}

async function deliver(command, title, message) {
  if (command) {
    await run("bash", ["-lc", command], {
      env: { ...process.env, SYMPHONY_NOTIFY_TITLE: title, SYMPHONY_NOTIFY_MESSAGE: message },
      timeout: 10000
    });
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error(`no built-in notifier for ${process.platform}; set notify.command in WORKFLOW.md`);
  }
  await run("osascript", ["-e", `display notification ${quote(message)} with title ${quote(title)}`], { timeout: 10000 });
}

// AppleScript strings take double quotes with backslash escapes, and a raw newline in one
// is a syntax error rather than a line break.
function quote(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
  return `"${flat.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
