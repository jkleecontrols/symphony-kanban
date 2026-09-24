import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// AI CLIs a user may have started themselves, in a terminal, outside Symphony.
const DEFAULT_NAMES = ["claude", "codex", "aider", "goose"];
const CACHE_MS = 2000;

let cache = { at: 0, sessions: [] };

// Sessions Symphony did not start still belong to a task, because the task is a folder.
// Finding them means asking the OS which AI processes are running and where.
export async function scanExternalSessions(names = DEFAULT_NAMES) {
  if (Date.now() - cache.at < CACHE_MS) return cache.sessions;
  const sessions = await scanNow(names).catch(() => []);
  cache = { at: Date.now(), sessions };
  return sessions;
}

async function scanNow(names) {
  const wanted = new Set(names);
  const { stdout } = await run("ps", ["-axo", "pid=,comm="], { maxBuffer: 4 * 1024 * 1024 });

  const candidates = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, comm] = match;
    // A GUI app bundle is not a CLI session; its helpers all report the same name.
    if (comm.includes("/Applications/") || comm.includes(".app/Contents/")) continue;
    const name = path.basename(comm);
    if (wanted.has(name)) candidates.push({ pid, name });
  }
  if (!candidates.length) return [];

  const cwdByPid = await workingDirectories(candidates.map((entry) => entry.pid));
  return candidates
    .map((entry) => ({ ...entry, cwd: cwdByPid.get(entry.pid) || null }))
    .filter((entry) => entry.cwd);
}

// One lsof call for every pid; -Fpn prints p<pid> then n<path> per record.
async function workingDirectories(pids) {
  const found = new Map();
  try {
    const { stdout } = await run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { maxBuffer: 4 * 1024 * 1024 });
    let current = null;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) current = line.slice(1);
      else if (line.startsWith("n") && current) found.set(current, line.slice(1));
    }
  } catch {
    // lsof exits non-zero when some pids are gone; whatever it printed is still usable
  }
  return found;
}

// A session counts for a task when it runs in the task's folder or below it.
export function sessionsForPath(sessions, workspacePath) {
  if (!workspacePath) return [];
  const root = path.resolve(workspacePath);
  return sessions.filter((session) => {
    const cwd = path.resolve(session.cwd);
    return cwd === root || cwd.startsWith(`${root}${path.sep}`);
  });
}
