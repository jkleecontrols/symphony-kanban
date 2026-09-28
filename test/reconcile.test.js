import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "../src/orchestrator.js";
import { resolveConfig } from "../src/workflow.js";

const events = [];
const logger = { event(level, name, data) { events.push({ level, name, ...data }); }, recent: [] };

function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function harness(issueOverrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-reconcile-"));
  const issuesPath = path.join(dir, "issues.json");
  await fs.writeFile(issuesPath, JSON.stringify([{
    id: "local-1",
    identifier: "KAN-1",
    title: "long running task",
    state: "Ready",
    labels: ["symphony"],
    dispatchable: true,
    ...issueOverrides
  }], null, 2));

  const config = resolveConfig({
    tracker: {
      kind: "local_json",
      provider: { path: issuesPath },
      active_states: ["Ready", "In Progress"],
      terminal_states: ["Done"]
    },
    polling: { interval_ms: 1000 },
    workspace: { root: path.join(dir, "workspaces") },
    agent: { max_turns: 1 },
    agents: { sleeper: { command: "sleep 120" } },
    codex: { stall_timeout_ms: 0, turn_timeout_ms: 600000 }
  }, dir);

  const workflow = { path: path.join(dir, "WORKFLOW.md"), dir, config, rawConfig: {}, promptTemplate: "work on {{ issue.identifier }}" };
  return { dir, issuesPath, orchestrator: new Orchestrator(workflow, logger) };
}

async function waitForPid(orchestrator) {
  for (let i = 0; i < 60; i += 1) {
    const pid = orchestrator.claims.get("local-1")?.codex_live_session?.codex_app_server_pid
      ?? orchestrator.runner.controls.get("local-1")?.child?.pid;
    if (pid) return String(pid);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("agent process never started");
}

test("moving a running issue to a terminal state kills the agent and clears the workspace", async () => {
  const { issuesPath, orchestrator } = await harness({ agent: "sleeper" });

  await orchestrator.poll();
  const pid = await waitForPid(orchestrator);
  assert.ok(alive(pid), "the agent process should be running");
  const workspace = path.join(orchestrator.config.workspace.root, "KAN-1");
  assert.ok((await fs.stat(workspace)).isDirectory());

  await orchestrator.tracker.updateIssueState("local-1", "Done");
  await orchestrator.reconcile();

  assert.equal(alive(pid), false, "the agent process must be terminated");
  assert.equal(orchestrator.claims.has("local-1"), false, "the claim must be released");
  assert.equal(await fs.access(workspace).then(() => true, () => false), false, "the workspace must be cleaned");
  assert.equal(orchestrator.failures.has("local-1"), false, "a cancellation is not a failure and earns no retry");

  const history = orchestrator.snapshot().dispatch_history.at(-1);
  assert.equal(history.status, "canceled");
  assert.ok(JSON.parse(await fs.readFile(issuesPath, "utf8")).length === 1);
});

test("a running issue that stops being dispatchable is terminated without touching its folder", async () => {
  const { dir, orchestrator } = await harness({ agent: "sleeper" });
  const project = path.join(dir, "my-project");
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "notes.md"), "# mine\n");
  await orchestrator.tracker.updateIssue("local-1", { workspace_path: project });

  await orchestrator.poll();
  const pid = await waitForPid(orchestrator);
  assert.ok(alive(pid));

  await orchestrator.tracker.updateIssue("local-1", { dispatchable: false });
  await orchestrator.reconcile();

  assert.equal(alive(pid), false, "the agent process must be terminated");
  assert.deepEqual(await fs.readdir(project), ["notes.md"], "the user's folder must be untouched");
});

test("a tracker read failure during reconcile leaves running work alone", async () => {
  const { orchestrator } = await harness({ agent: "sleeper" });
  await orchestrator.poll();
  const pid = await waitForPid(orchestrator);

  orchestrator.tracker.fetchIssuesByIds = async () => { throw new Error("tracker offline"); };
  await orchestrator.reconcile();

  assert.ok(alive(pid), "a read failure must not kill in-flight work");
  assert.ok(orchestrator.claims.has("local-1"));
  orchestrator.runner.cancel("local-1", "test cleanup");
  await orchestrator.claims.get("local-1")?.promise?.catch(() => {});
});
