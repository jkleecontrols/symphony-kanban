import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Apps that host a session. Walking a session's ancestry finds whichever one launched it,
// so the board goes to that window instead of opening a second one beside it.
const HOSTS = new Set([
  "Terminal", "iTerm2", "iTerm", "Ghostty", "Warp", "Alacritty", "kitty", "WezTerm",
  "Hyper", "ChatGPT", "Code", "Cursor"
]);

const MAX_DEPTH = 12;

export async function openOrRaise(folder, { app = "iTerm", sessions = [] } = {}) {
  // A session started in a terminal owns a tty, and that is enough to pick out its exact
  // tab among many. One without a tty was started by a GUI app, where the app itself is
  // the only thing there is to raise.
  for (const session of sessions) {
    const tty = await ttyOf(session.pid);
    if (!tty) continue;
    const host = await hostOf(session.pid);
    const focused = await focusTty(host, tty);
    if (focused) return { action: "focused", app: focused, tty };
  }

  for (const session of sessions) {
    const host = await hostOf(session.pid);
    if (!host) continue;
    await activate(host);
    return { action: "raised", app: host };
  }

  await run("open", ["-a", app, folder], { timeout: 10000 });
  return { action: "opened", app };
}

// iTerm2 and Terminal both expose a tab's tty, so the tab can be matched exactly rather
// than guessed at. Unknown terminals fall back to raising the application.
async function focusTty(host, tty) {
  const candidates = host ? [host] : ["iTerm2", "Terminal"];
  for (const name of candidates) {
    const script = name.startsWith("iTerm") ? itermScript(name, tty) : name === "Terminal" ? terminalScript(tty) : null;
    if (!script) continue;
    try {
      const { stdout } = await run("osascript", ["-e", script], { timeout: 10000 });
      if (stdout.trim() === "ok") return name;
    } catch {
      // that app is not running, or not scriptable; try the next
    }
  }
  return null;
}

function itermScript(name, tty) {
  return `
    tell application "${name}"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is "${tty}" then
              select w
              select t
              select s
              activate
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
    end tell
    return "none"`;
}

function terminalScript(tty) {
  return `
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if tty of t is "${tty}" then
            set frontmost of w to true
            set selected of t to true
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end tell
    return "none"`;
}

async function ttyOf(pid) {
  try {
    const { stdout } = await run("ps", ["-p", String(pid), "-o", "tty="], { timeout: 5000 });
    const name = stdout.trim();
    if (!name || name === "??" || name === "?") return null;
    return name.startsWith("/dev/") ? name : `/dev/${name}`;
  } catch {
    return null;
  }
}

// A session's process is a child of whatever window it runs in; the app is up the chain.
async function hostOf(startPid) {
  let pid = String(startPid || "").trim();
  for (let depth = 0; depth < MAX_DEPTH && pid && pid !== "0" && pid !== "1"; depth += 1) {
    const info = await processInfo(pid);
    if (!info) return null;
    const name = baseName(info.comm);
    if (HOSTS.has(name)) return name;
    pid = info.ppid;
  }
  return null;
}

async function processInfo(pid) {
  try {
    const { stdout } = await run("ps", ["-p", pid, "-o", "ppid=,comm="], { timeout: 5000 });
    const match = stdout.trim().match(/^(\d+)\s+(.*)$/);
    return match ? { ppid: match[1], comm: match[2] } : null;
  } catch {
    return null;
  }
}

// "/Applications/iTerm.app/Contents/MacOS/iTerm2" -> "iTerm"
function baseName(comm) {
  const bundle = comm.match(/\/([^/]+)\.app\//);
  return bundle ? bundle[1] : comm.split("/").pop();
}

async function activate(app) {
  await run("osascript", ["-e", `tell application "${app}" to activate`], { timeout: 10000 });
}
