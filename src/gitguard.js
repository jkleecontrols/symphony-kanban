import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Auto-dispatch lets an agent write with nobody watching. This does not fence it into
// the task's folder -- no generic mechanism can -- but it refuses to start unless that
// folder is under version control, so whatever happens there can be seen and undone.
export async function inspect(folder) {
  if (!folder) return { git: false, reason: "the task has no project folder" };
  try {
    const top = (await git(folder, ["rev-parse", "--show-toplevel"])).trim();
    const head = (await git(folder, ["rev-parse", "HEAD"])).trim();
    const branch = (await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const status = await git(folder, ["status", "--porcelain"]);
    const dirty = status.split("\n").filter(Boolean).length;
    // In a worktree, top is the worktree and the shared .git lives with the main
    // checkout, so its parent is the project every worktree belongs to.
    const commonDir = (await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const project = commonDir ? path.dirname(commonDir) : top;
    return { git: true, top, head, branch, dirty, project, is_worktree: project !== top };
  } catch (error) {
    return { git: false, reason: reasonFor(error, folder) };
  }
}

// What a run changed inside the folder, so the board can show its blast radius.
export async function changesSince(folder, before) {
  if (!before?.git) return null;
  const after = await inspect(folder);
  if (!after.git) return null;

  const changed = { head_before: before.head, head_after: after.head, commits: 0, files: 0, insertions: 0, deletions: 0 };
  if (before.head !== after.head) {
    const count = await git(folder, ["rev-list", "--count", `${before.head}..${after.head}`]).catch(() => "0");
    changed.commits = Number(count.trim()) || 0;
  }
  const stat = await git(folder, ["diff", "--shortstat", before.head]).catch(() => "");
  const files = stat.match(/(\d+) files? changed/);
  const insertions = stat.match(/(\d+) insertions?/);
  const deletions = stat.match(/(\d+) deletions?/);
  changed.files = files ? Number(files[1]) : 0;
  changed.insertions = insertions ? Number(insertions[1]) : 0;
  changed.deletions = deletions ? Number(deletions[1]) : 0;
  changed.working_tree_dirty = after.dirty;
  return changed;
}

function reasonFor(error, folder) {
  const text = `${error.stderr || ""}${error.message || ""}`;
  if (/not a git repository/i.test(text)) return `${path.resolve(folder)} is not a git repository`;
  if (/unknown revision|does not have any commits/i.test(text)) return `${path.resolve(folder)} has no commits yet`;
  return `git could not read ${path.resolve(folder)}: ${error.message}`;
}

async function git(cwd, args) {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}
