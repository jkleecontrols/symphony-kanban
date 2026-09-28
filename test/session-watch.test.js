import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "../src/orchestrator.js";
import { resolveConfig } from "../src/workflow.js";
import { looksLikeAQuestion, phaseOf } from "../src/transcripts.js";

const logger = { event() {}, recent: [] };
const STATES = { working: "In Progress", idle: "Ready", waiting: "Human Review", ended: "Done" };

async function harness(state, sessionsOverride = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-watch-"));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  const issuesPath = path.join(dir, "issues.json");
  await fs.writeFile(issuesPath, JSON.stringify([{
    id: "local-1", identifier: "KAN-1", title: "folder task", state,
    labels: ["symphony"], dispatchable: false, workspace_path: project,
    updated_at: new Date().toISOString()
  }], null, 2));

  const config = resolveConfig({
    tracker: {
      kind: "local_json",
      provider: { path: issuesPath },
      active_states: ["Ready", "In Progress", "Human Review"],
      terminal_states: ["Done", "Archive"]
    },
    workspace: { root: path.join(dir, "workspaces") },
    sessions: { settle_polls: 2, states: STATES, ...sessionsOverride },
    archive: { enabled: false },
    agents: { noop: { command: "true" } }
  }, dir);

  const orchestrator = new Orchestrator({ path: dir, dir, config, rawConfig: {}, promptTemplate: "x" }, logger);
  return { orchestrator, project };
}

const stateOf = async (o) => (await o.tracker.readIssues())[0].state;
const session = (project, phase) => [{ name: "claude", pid: "1", cwd: project, phase }];

test("stop_reason decides whether a session is working or handing back control", () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  assert.equal(phaseOf("tool_use", "", old), "working", "a mid-turn tool call is work");
  assert.equal(phaseOf("end_turn", "all done, deployed it", old), "idle");
  assert.equal(phaseOf("end_turn", "which folder should I use?", old), "waiting");
  assert.equal(phaseOf("end_turn", "all done", now), "working", "a turn that just ended still reads as busy");
});

test("a question at the end of a turn is what separates waiting from idle", () => {
  assert.equal(looksLikeAQuestion("Should I push this?"), true);
  assert.equal(looksLikeAQuestion("어느 쪽으로 할까요"), true);
  assert.equal(looksLikeAQuestion("배포까지 끝냈습니다."), false);
  assert.equal(looksLikeAQuestion(""), false);
});

test("a working session puts the task in progress", async () => {
  const { orchestrator, project } = await harness("Ready");
  orchestrator.scanSessions = async () => session(project, "working");
  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "In Progress");
});

test("a session waiting on an answer puts the task in human review", async () => {
  const { orchestrator, project } = await harness("In Progress");
  orchestrator.scanSessions = async () => session(project, "waiting");
  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "Human Review");
});

test("an open but idle session puts the task back to ready", async () => {
  const { orchestrator, project } = await harness("In Progress");
  orchestrator.scanSessions = async () => session(project, "idle");
  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "Ready");
});

test("a session that ends moves the task to done, after settling", async () => {
  const { orchestrator, project } = await harness("In Progress");
  let live = session(project, "working");
  orchestrator.scanSessions = async () => live;

  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "In Progress");

  live = [];
  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "In Progress", "one missing poll may be a restart");

  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "Done");
});

test("a card parked in a state the watcher does not own is left alone", async () => {
  const { orchestrator, project } = await harness("Archive");
  orchestrator.scanSessions = async () => session(project, "working");
  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "Archive");
});

test("a task Symphony is running itself is not moved by the watcher", async () => {
  const { orchestrator, project } = await harness("In Progress");
  orchestrator.claims.set("local-1", { issue_id: "local-1", status: "StreamingTurn" });
  orchestrator.scanSessions = async () => session(project, "idle");
  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "In Progress");
});

test("watching can be turned off", async () => {
  const { orchestrator, project } = await harness("In Progress", { watch: false });
  orchestrator.scanSessions = async () => session(project, "idle");
  await orchestrator.watchExternalSessions();
  assert.equal(await stateOf(orchestrator), "In Progress");
});

test("Done moves to Archive once it has sat untouched for the configured days", async () => {
  const { orchestrator } = await harness("Done");
  orchestrator.config.archive = { enabled: true, from_state: "Done", to_state: "Archive", after_days: 2 };

  await orchestrator.sweepArchive();
  assert.equal(await stateOf(orchestrator), "Done", "freshly finished work stays visible");

  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  const [issue] = await orchestrator.tracker.readRawIssues();
  issue.updated_at = old;
  await orchestrator.tracker.writeRawIssues([issue]);

  await orchestrator.sweepArchive();
  assert.equal(await stateOf(orchestrator), "Archive");
});
