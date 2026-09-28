import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runVerification, suggestCommand, summarize } from "../src/verify.js";
import { Orchestrator } from "../src/orchestrator.js";
import { resolveConfig } from "../src/workflow.js";

const run = promisify(execFile);
const logger = { event() {}, recent: [] };

test("a passing check records success and its output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-verify-"));
  const result = await runVerification("echo all good", dir, 10000);
  assert.equal(result.ok, true);
  assert.equal(result.exit_code, 0);
  assert.match(result.output_tail, /all good/);
});

test("a failing check keeps the exit code and the output rather than throwing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-verify-"));
  const result = await runVerification("echo boom >&2; exit 3", dir, 10000);
  assert.equal(result.ok, false);
  assert.equal(result.exit_code, 3);
  assert.match(result.output_tail, /boom/, "a failure's output is the evidence worth keeping");
});

test("a check that hangs is stopped and marked as timed out", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-verify-"));
  const result = await runVerification("sleep 30", dir, 400);
  assert.equal(result.ok, false);
  assert.equal(result.timed_out, true);
});

test("a check runs in the task's folder", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-verify-"));
  await fs.writeFile(path.join(dir, "marker.txt"), "x");
  const result = await runVerification("ls marker.txt", dir, 10000);
  assert.equal(result.ok, true);
});

test("a check command is suggested from what the folder contains", () => {
  assert.equal(suggestCommand(["package.json", "src"]), "npm test");
  assert.equal(suggestCommand(["pyproject.toml"]), "pytest -q");
  assert.equal(suggestCommand(["README.md"]), null, "no guess is better than a wrong one");
});

test("the summary states changes and verdict in one line", () => {
  assert.match(summarize({ changes: { commits: 0, files: 2, insertions: 14, deletions: 3 }, verify: { ok: true } }), /2 files, \+14\/-3 · checks passed/);
  assert.match(summarize({ changes: { commits: 0, files: 0, insertions: 0, deletions: 0 }, verify: null }), /no changes · no check configured/);
  assert.match(summarize({ changes: null, verify: { ok: false } }), /checks failed/);
});

async function repoOrchestrator(verifyCommand) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-evidence-"));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  await run("git", ["-C", project, "init", "-q"]);
  await run("git", ["-C", project, "config", "user.email", "t@example.com"]);
  await run("git", ["-C", project, "config", "user.name", "t"]);
  await fs.writeFile(path.join(project, "a.txt"), "one\n");
  await run("git", ["-C", project, "add", "-A"]);
  await run("git", ["-C", project, "commit", "-qm", "first"]);

  const issuesPath = path.join(dir, "issues.json");
  await fs.writeFile(issuesPath, JSON.stringify([{
    id: "local-1", identifier: "KAN-1", title: "t", state: "Ready",
    labels: ["symphony"], dispatchable: true, agent: "writer",
    workspace_path: project, verify_command: verifyCommand,
    updated_at: new Date().toISOString()
  }], null, 2));

  const config = resolveConfig({
    tracker: { kind: "local_json", provider: { path: issuesPath }, active_states: ["Ready"], terminal_states: ["Done"] },
    workspace: { root: path.join(dir, "workspaces") },
    agent: { max_turns: 1 },
    sessions: { watch: false },
    archive: { enabled: false },
    agents: { writer: { command: "printf 'two\\n' >> a.txt" } },
    verify: { timeout_ms: 10000 }
  }, dir);

  return { orchestrator: new Orchestrator({ path: dir, dir, config, rawConfig: {}, promptTemplate: "x" }, logger), project };
}

test("a completed run leaves evidence of what it changed and whether checks passed", async () => {
  const { orchestrator } = await repoOrchestrator("test -f a.txt");
  await orchestrator.poll();
  await orchestrator.claims.get("local-1")?.promise?.catch(() => {});

  const [issue] = await orchestrator.tracker.readIssues();
  const run = issue.last_run;
  assert.ok(run, "the run is recorded on the task, so it survives a restart");
  assert.equal(run.verify.ok, true);
  assert.equal(run.verify.command, "test -f a.txt");
  assert.equal(run.changes.working_tree_dirty, 1, "the agent's edit shows up as a change");
  assert.match(run.summary, /checks passed/);
  assert.ok(run.at && run.agent === "writer");
});

test("a failing check is recorded as failed, not hidden", async () => {
  const { orchestrator } = await repoOrchestrator("exit 1");
  await orchestrator.poll();
  await orchestrator.claims.get("local-1")?.promise?.catch(() => {});

  const [issue] = await orchestrator.tracker.readIssues();
  assert.equal(issue.last_run.verify.ok, false);
  assert.match(issue.last_run.summary, /checks failed/);
});

test("with no check command the run still records what changed", async () => {
  const { orchestrator } = await repoOrchestrator(null);
  await orchestrator.poll();
  await orchestrator.claims.get("local-1")?.promise?.catch(() => {});

  const [issue] = await orchestrator.tracker.readIssues();
  assert.equal(issue.last_run.verify, null);
  assert.match(issue.last_run.summary, /no check configured/);
  assert.equal(issue.last_run.changes.working_tree_dirty, 1);
});
