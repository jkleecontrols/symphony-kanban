#!/usr/bin/env node

// Links every markdown file in a project into an Obsidian vault, so notes written in a
// repository and notes written in the vault are the same notes.
//
// Symlinks rather than copies: a copy goes stale the moment either side is edited, and
// these files are the repositories' own documentation. The whole folder is not linked
// because these repositories hold thousands of files each and Obsidian would index all
// of them; only the markdown is.
//
//   node scripts/vault-sync.js            # read projects from the board
//   node scripts/vault-sync.js --dry-run

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".obsidian", "dist", "build", ".next"]);
const MAX_DEPTH = 6;
const LOG_MARKER = "<!-- symphony:log -->";

export async function syncVault({ vault, projects, dryRun = false }) {
  const root = path.join(vault, "Projects");
  if (!dryRun) await fs.mkdir(root, { recursive: true });

  const report = [];
  for (const project of projects) {
    const name = path.basename(project.path);
    const dest = path.join(root, name);
    const files = await markdownFiles(project.path);

    if (!dryRun) {
      await fs.mkdir(dest, { recursive: true });
      await pruneStaleLinks(dest, project.path);
    }

    for (const relative of files) {
      const target = path.join(project.path, relative);
      if (!dryRun) await replaceLink(path.join(dest, linkName(name, relative)), target);
    }

    if (!dryRun) await writeIndex(root, name, project, files);
    report.push({ project: name, linked: files.length });
  }

  return report;
}

// Only ever removes links this script made that point into this project. A real note
// someone wrote in the vault is never touched.
async function pruneStaleLinks(dest, projectPath) {
  let entries;
  try {
    entries = await fs.readdir(dest, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const full = path.join(dest, entry.name);
    try {
      const target = await fs.readlink(full);
      if (!target.startsWith(projectPath)) continue;
      await fs.access(target);
    } catch {
      await fs.rm(full, { force: true });
    }
  }
}

async function replaceLink(link, target) {
  try {
    if (await fs.readlink(link) === target) return;
  } catch {
    // not a link yet, or not there
  }
  await fs.rm(link, { force: true }).catch(() => {});
  await fs.symlink(target, link);
}

// The project's own note lives inside its folder, so the vault shows one entry per project
// rather than a note and a folder of the same name side by side.
function indexPathFor(root, name) {
  return path.join(root, name, `${name}.md`);
}

// Where the note used to be. Read once to carry its log over, then removed.
function legacyIndexPath(root, name) {
  return path.join(root, `${name}.md`);
}

// A repository file that would land on the project note's own name is linked under
// another one; otherwise the link would replace the note and its log.
function linkName(name, relative) {
  const flat = relative.replaceAll(path.sep, " · ");
  return flat === `${name}.md` ? `${name} · file.md` : flat;
}

// One note per project: the entry point Obsidian's graph hangs the rest off.
async function writeIndex(root, name, project, files) {
  const indexPath = indexPathFor(root, name);
  const legacyPath = legacyIndexPath(root, name);
  // Linked by path, not by name alone: most projects have a README, a CLAUDE and a
  // handoff · STATUS, and a bare [[README]] cannot say which project's it means.
  const links = files
    .map((relative) => linkName(name, relative).replace(/\.md$/, ""))
    .sort()
    .map((note) => `- [[Projects/${name}/${note}|${note}]]`)
    .join("\n");

  const body = `# ${name}

Project folder: \`${project.path}\`${project.branch ? ` · branch \`${project.branch}\`` : ""}
${project.board ? `Board: ${project.board}` : ""}

## Notes in this project

${links || "_No markdown in this project yet._"}

## Log

${LOG_MARKER}
`;

  // Anything already written under the log marker is kept.
  let existingLog = "";
  for (const candidate of [indexPath, legacyPath]) {
    try {
      const current = await fs.readFile(candidate, "utf8");
      const at = current.indexOf(LOG_MARKER);
      if (at !== -1) existingLog = current.slice(at + LOG_MARKER.length);
      break;
    } catch {
      // not there: first run, or already moved
    }
  }
  await fs.writeFile(indexPath, body + existingLog.replace(/^\n+/, "\n"));
  await fs.rm(legacyPath, { force: true });
}

async function markdownFiles(dir, prefix = "", depth = 0) {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      found.push(...await markdownFiles(path.join(dir, entry.name), relative, depth + 1));
    } else if (entry.name.toLowerCase().endsWith(".md")) {
      found.push(relative);
    }
  }
  return found;
}

// Appends one line under a project's Log heading. This is how a finished run leaves a
// trace that outlives the board's own state.
export async function appendToLog(vault, projectName, line) {
  const root = path.join(vault, "Projects");
  let indexPath;
  let current;
  for (const candidate of [indexPathFor(root, projectName), legacyIndexPath(root, projectName)]) {
    try {
      current = await fs.readFile(candidate, "utf8");
      indexPath = candidate;
      break;
    } catch {
      // try the next place
    }
  }
  if (current === undefined) return false;
  const at = current.indexOf(LOG_MARKER);
  if (at === -1) return false;
  const head = current.slice(0, at + LOG_MARKER.length);
  const tail = current.slice(at + LOG_MARKER.length);
  await fs.writeFile(indexPath, `${head}\n${line}${tail}`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry-run");
  const vault = process.env.SYMPHONY_VAULT || path.join(os.homedir(), "Documents", "Obsidian Vault");
  const board = process.env.SYMPHONY_BOARD || "http://127.0.0.1:8787";

  const issues = await fetch(`${board}/api/issues`).then((r) => r.json());
  const seen = new Map();
  for (const issue of issues) {
    const folder = issue.project || issue.workspace_path;
    if (!folder || seen.has(folder)) continue;
    seen.set(folder, { path: folder, branch: issue.branch_name, board: `${issue.identifier} on ${board}` });
  }

  const report = await syncVault({ vault, projects: [...seen.values()], dryRun });
  for (const row of report) console.log(`${String(row.linked).padStart(3)} notes  ${row.project}`);
  console.log(`\n${dryRun ? "dry run" : "linked"} into ${path.join(vault, "Projects")}`);
}
