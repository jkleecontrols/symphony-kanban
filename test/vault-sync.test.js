import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncVault, appendToLog } from "../scripts/vault-sync.js";

const LOG_MARKER = "<!-- symphony:log -->";

async function tempVault() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-vault-"));
  const vault = path.join(base, "vault");
  const project = path.join(base, "magnet");
  await fs.mkdir(path.join(project, "docs"), { recursive: true });
  await fs.writeFile(path.join(project, "README.md"), "# magnet\n");
  await fs.writeFile(path.join(project, "docs", "BRINGUP.md"), "# bring-up\n");
  return { vault, project, projects: [{ path: project, branch: "main", board: "KAN-9" }] };
}

test("the project note lives inside the project's folder and links its files by path", async () => {
  const { vault, projects } = await tempVault();
  await syncVault({ vault, projects });

  const entries = await fs.readdir(path.join(vault, "Projects"));
  assert.deepEqual(entries, ["magnet"]);

  const note = await fs.readFile(path.join(vault, "Projects", "magnet", "magnet.md"), "utf8");
  assert.match(note, /\[\[Projects\/magnet\/README\|README\]\]/);
  assert.match(note, /\[\[Projects\/magnet\/docs · BRINGUP\|docs · BRINGUP\]\]/);
});

test("a note left beside the folder is moved in with its log", async () => {
  const { vault, projects } = await tempVault();
  await fs.mkdir(path.join(vault, "Projects"), { recursive: true });
  const legacy = path.join(vault, "Projects", "magnet.md");
  await fs.writeFile(legacy, `# magnet\n\n## Log\n\n${LOG_MARKER}\n- 2026-10-01 an earlier run\n`);

  await syncVault({ vault, projects });

  await assert.rejects(fs.access(legacy));
  const note = await fs.readFile(path.join(vault, "Projects", "magnet", "magnet.md"), "utf8");
  assert.match(note, /- 2026-10-01 an earlier run/);
});

test("a log line is appended to the note inside the folder, and survives the next sync", async () => {
  const { vault, projects } = await tempVault();
  await syncVault({ vault, projects });

  assert.equal(await appendToLog(vault, "magnet", "- 2026-10-07 a finished run"), true);
  await syncVault({ vault, projects });

  const note = await fs.readFile(path.join(vault, "Projects", "magnet", "magnet.md"), "utf8");
  assert.match(note, /- 2026-10-07 a finished run/);
  assert.equal(await appendToLog(vault, "no-such-project", "- nothing"), false);
});

test("a repository file named after its project does not replace the project note", async () => {
  const { vault, project, projects } = await tempVault();
  await fs.writeFile(path.join(project, "magnet.md"), "# the repository's own file\n");
  await syncVault({ vault, projects });

  const folder = path.join(vault, "Projects", "magnet");
  assert.equal((await fs.lstat(path.join(folder, "magnet.md"))).isSymbolicLink(), false);
  assert.equal(await fs.readlink(path.join(folder, "magnet · file.md")), path.join(project, "magnet.md"));
  assert.equal(await fs.readFile(path.join(project, "magnet.md"), "utf8"), "# the repository's own file\n");
});
