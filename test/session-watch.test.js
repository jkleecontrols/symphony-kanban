import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "../src/orchestrator.js";
import { resolveConfig } from "../src/workflow.js";

const logger = { event() {}, recent: [] };

async function harness(state, sessionsOverride = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-watch-"));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  const issuesPath = path.join(dir, "issues.json");
  await fs.writeFile(issuesPath, JSON.stringify([{
    id: "local-1",
    identifier: "KAN-1",
    title: "folder task",
    state,
    labels: ["symphony"],
    dispatchable: false,
    workspace_path: project
  }], null, 2));

  const config = resolveConfig({
    tracker: {
      kind: "local_json",
      provider: { path: issuesPath },
      active_states: ["Ready", "In Progress", "Human Review"],
      terminal_states: ["Done"]
    },
    workspace: { root: path.join(dir, "workspaces") },
    sessions: { from_states: ["In Progress"], to_state: "Human Review", settle_polls: 2, ...sessionsOverride },
    agents: { noop: { command: "true" } }
  }, dir);

  const orchestrator = new Orchestrator({ path: dir, dir, config, rawConfig: {}, promptTemplate: "x" }, logger);
  return { orchestrator, project };
}

async function stateOf(orchestrator) {
  const [issue] = await orchestrator.tracker.readIssues();
  return issue.state;
}

test("a task moves to Human Review only after its session has been gone for settle_polls", async () => {
  const { orchestrator, project } = await harness("In Progress");
  let live = [{ name: "claude", pid: "1", cwd: project }];
  orchestrator.scanSessions = async () => live;

  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "In Progress", "a live session leaves the task alone");

  live = [];
  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "In Progress", "one empty poll is not enough to move it");

  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "Human Review", "a settled absence moves the task on");
});

test("a task never seen running is left where it is", async () => {
  const { orchestrator } = await harness("In Progress");
  orchestrator.scanSessions = async () => [];

  await orchestrator.watchExternalSessions();
  await orchestrator.watchExternalSessions();
  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "In Progress");
});

test("a task outside from_states is not moved when its session ends", async () => {
  const { orchestrator, project } = await harness("Ready");
  let live = [{ name: "claude", pid: "1", cwd: project }];
  orchestrator.scanSessions = async () => live;

  await orchestrator.watchExternalSessions();
  live = [];
  await orchestrator.watchExternalSessions();
  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "Ready");
});

test("watching can be turned off", async () => {
  const { orchestrator, project } = await harness("In Progress", { watch: false });
  let live = [{ name: "claude", pid: "1", cwd: project }];
  orchestrator.scanSessions = async () => live;

  await orchestrator.watchExternalSessions();
  live = [];
  await orchestrator.watchExternalSessions();
  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "In Progress");
});
