import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceManager } from "../src/workspace.js";

const silentLogger = { event() {} };

function makeConfig(root) {
  return {
    workspace: { root },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 1000 }
  };
}

async function tempDirs() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-ws-"));
  const root = path.join(base, "workspaces");
  const project = path.join(base, "my-real-project");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "notes.md"), "# real work\n");
  return { base, root, project };
}

test("a task without workspace_path gets a managed workspace under the root", async () => {
  const { root } = await tempDirs();
  const manager = new WorkspaceManager(makeConfig(root), silentLogger);
  const workspace = await manager.prepare({ id: "local-1", identifier: "KAN-1", workspace_path: null });
  assert.equal(workspace.path, path.join(root, "KAN-1"));
  assert.equal(workspace.external, undefined);
  assert.ok((await fs.stat(workspace.path)).isDirectory());
});

test("a task with workspace_path runs in that folder and creates nothing", async () => {
  const { root, project } = await tempDirs();
  const manager = new WorkspaceManager(makeConfig(root), silentLogger);
  const workspace = await manager.prepare({ id: "local-1", identifier: "KAN-1", workspace_path: project });

  assert.equal(workspace.path, project);
  assert.equal(workspace.external, true);
  assert.deepEqual(await fs.readdir(project), ["notes.md"], "the folder must be left exactly as it was");
  assert.deepEqual(await fs.readdir(root), [], "no managed workspace should be created alongside it");
});

test("a missing or non-directory workspace_path is rejected, not created", async () => {
  const { root, base, project } = await tempDirs();
  const manager = new WorkspaceManager(makeConfig(root), silentLogger);
  const missing = path.join(base, "nope");

  await assert.rejects(
    () => manager.prepare({ id: "local-1", identifier: "KAN-1", workspace_path: missing }),
    /does not exist/
  );
  assert.equal(await fs.access(missing).then(() => true, () => false), false, "must not create the folder");

  const file = path.join(project, "notes.md");
  await assert.rejects(
    () => manager.prepare({ id: "local-2", identifier: "KAN-2", workspace_path: file }),
    /not a directory/
  );
});

test("remove never touches a folder the task pointed at", async () => {
  const { root, project } = await tempDirs();
  const manager = new WorkspaceManager(makeConfig(root), silentLogger);

  await manager.remove({ id: "local-1", identifier: "KAN-1", workspace_path: project });

  assert.ok((await fs.stat(project)).isDirectory(), "the user's project folder must survive");
  assert.deepEqual(await fs.readdir(project), ["notes.md"]);
});

test("remove still cleans up a managed workspace", async () => {
  const { root } = await tempDirs();
  const manager = new WorkspaceManager(makeConfig(root), silentLogger);
  const issue = { id: "local-1", identifier: "KAN-1", workspace_path: null };
  const workspace = await manager.prepare(issue);

  await manager.remove(issue);

  assert.equal(await fs.access(workspace.path).then(() => true, () => false), false);
});
