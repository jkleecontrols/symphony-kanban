import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { changesSince, inspect } from "../src/gitguard.js";
import { Orchestrator } from "../src/orchestrator.js";
import { resolveConfig } from "../src/workflow.js";

const run = promisify(execFile);
const events = [];
const logger = { event(level, name, data) { events.push({ level, name, ...data }); }, recent: [] };

async function repo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-guard-"));
  await run("git", ["-C", dir, "init", "-q"]);
  await run("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", dir, "config", "user.name", "t"]);
  await fs.writeFile(path.join(dir, "a.txt"), "one\n");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "commit", "-qm", "first"]);
  return dir;
}

test("a git folder passes and reports its head and cleanliness", async () => {
  const dir = await repo();
  const state = await inspect(dir);
  assert.equal(state.git, true);
  assert.equal(state.dirty, 0);
  assert.match(state.head, /^[0-9a-f]{40}$/);
});

test("a folder with no repository, and one with no commits, are both refused", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-plain-"));
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-empty-"));
  await run("git", ["-C", empty, "init", "-q"]);

  const a = await inspect(plain);
  assert.equal(a.git, false);
  assert.match(a.reason, /not a git repository/);

  const b = await inspect(empty);
  assert.equal(b.git, false);
  assert.match(b.reason, /no commits yet/, "a repo with no commits has no point to undo to");

  assert.equal((await inspect(null)).git, false, "a task with no folder cannot be guarded");
});

test("changesSince reports what a run left behind", async () => {
  const dir = await repo();
  const before = await inspect(dir);
  await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  await fs.writeFile(path.join(dir, "b.txt"), "new\n");

  const changes = await changesSince(dir, before);
  assert.equal(changes.head_before, before.head);
  assert.equal(changes.commits, 0);
  assert.ok(changes.insertions >= 2, `expected insertions, got ${JSON.stringify(changes)}`);
  assert.equal(changes.working_tree_dirty, 2);
});

async function orchestratorFor(workspacePath, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-guard-orch-"));
  const issuesPath = path.join(dir, "issues.json");
  await fs.writeFile(issuesPath, JSON.stringify([{
    id: "local-1", identifier: "KAN-1", title: "t", state: "Ready",
    labels: ["symphony"], dispatchable: true, workspace_path: workspacePath,
    updated_at: new Date().toISOString()
  }], null, 2));

  const config = resolveConfig({
    tracker: { kind: "local_json", provider: { path: issuesPath }, active_states: ["Ready"], terminal_states: ["Done"] },
    workspace: { root: path.join(dir, "workspaces") },
    agents: { noop: { command: "true" } },
    ...extra
  }, dir);
  return new Orchestrator({ path: dir, dir, config, rawConfig: {}, promptTemplate: "x" }, logger);
}

test("dispatch is refused for a folder that is not under version control", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-nogit-"));
  const orchestrator = await orchestratorFor(plain);
  events.length = 0;

  await orchestrator.poll();

  assert.equal(orchestrator.claims.size, 0, "nothing may run in a folder with no undo");
  assert.match(orchestrator.guardRefused.get("local-1"), /not a git repository/);
  const refusal = events.find((e) => e.name === "dispatch_refused");
  assert.ok(refusal, "the operator must be told why");

  events.length = 0;
  await orchestrator.poll();
  assert.equal(events.filter((e) => e.name === "dispatch_refused").length, 0, "the same refusal is not logged twice");
});

test("dispatch proceeds for a git folder and records what changed", async () => {
  const dir = await repo();
  const orchestrator = await orchestratorFor(dir, { agent: { max_turns: 1 } });
  await orchestrator.tracker.updateIssue("local-1", { agent: "noop" });

  await orchestrator.poll();
  await orchestrator.claims.get("local-1")?.promise?.catch(() => {});

  assert.equal(orchestrator.guardRefused.has("local-1"), false);
  const changes = orchestrator.lastChanges.get("local-1");
  assert.ok(changes, "a completed run records its diff");
  assert.equal(changes.head_before, changes.head_after);
});

test("the guard can be turned off", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-nogit2-"));
  const orchestrator = await orchestratorFor(plain, { dispatch_guard: { require_git: false }, agent: { max_turns: 1 } });
  await orchestrator.tracker.updateIssue("local-1", { agent: "noop" });

  await orchestrator.poll();
  assert.equal(orchestrator.guardRefused.size, 0);
  await orchestrator.claims.get("local-1")?.promise?.catch(() => {});
});
