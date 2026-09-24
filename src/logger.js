import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { nowIso } from "./utils.js";

export class Logger {
  constructor(logPath) {
    this.logPath = logPath;
    this.recent = [];
    this.stream = null;
  }

  async start() {
    await fsp.mkdir(path.dirname(this.logPath), { recursive: true });
    this.stream = fs.createWriteStream(this.logPath, { flags: "a" });
  }

  event(level, event, data = {}) {
    const record = { ts: nowIso(), level, event, ...redact(data) };
    this.recent.push(record);
    if (this.recent.length > 500) this.recent.shift();
    if (this.stream) this.stream.write(`${JSON.stringify(record)}\n`);
    if (level === "error") console.error(JSON.stringify(record));
    else console.log(JSON.stringify(record));
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/secret|password|credential|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token/i.test(key)) return [key, "[redacted]"];
    return [key, redact(item)];
  }));
}
