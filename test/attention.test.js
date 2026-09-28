import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Notifier } from "../src/notify.js";
import { isStale } from "../src/sessions.js";
import { Orchestrator } from "../src/orchestrator.js";
import { resolveConfig } from "../src/workflow.js";

const logger = { event() {}, recent: [] };
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

// send() reports whether it actually delivered, which is all these need to assert.
function notifier(overrides = {}) {
  return new Notifier({ notify: { enabled: true, on: [], command: "true", ...overrides } }, logger);
}

test("the same alert does not repeat while it is still true", async () => {
  const n = notifier();
  assert.equal(await n.send("human_review", { key: "local-1", title: "t", message: "m" }), true);
  assert.equal(await n.send("human_review", { key: "local-1", title: "t", message: "m" }), false,
    "a card waiting for an answer must not nag on every poll");

  n.forget("local-1");
  assert.equal(await n.send("human_review", { key: "local-1", title: "t", message: "m" }), true,
    "once it moves on, the next time it needs you is worth saying again");
});

test("a different card alerts on its own", async () => {
  const n = notifier();
  assert.equal(await n.send("human_review", { key: "local-1", title: "t", message: "m" }), true);
  assert.equal(await n.send("human_review", { key: "local-2", title: "t", message: "m" }), true);
});

test("events can be filtered, and notifications can be turned off", async () => {
  const only = notifier({ on: ["check_failed"] });
  assert.equal(await only.send("human_review", { key: "a", title: "t", message: "m" }), false);
  assert.equal(await only.send("check_failed", { key: "a", title: "t", message: "m" }), true);

  const off = notifier({ enabled: false });
  assert.equal(await off.send("check_failed", { key: "b", title: "t", message: "m" }), false);
});

test("a delivery that fails is reported rather than thrown", async () => {
  const n = notifier({ command: "exit 7" });
  assert.equal(await n.send("check_failed", { key: "c", title: "t", message: "m" }), false);
});

test("a session quiet for longer than the threshold stops counting as live", () => {
  assert.equal(isStale({ at: hoursAgo(45) }, 12), true, "a terminal left open for days is not work in progress");
  assert.equal(isStale({ at: hoursAgo(1) }, 12), false);
  assert.equal(isStale({ at: hoursAgo(45) }, 0), false, "zero disables the idea entirely");
  assert.equal(isStale({ at: null }, 12), false, "an unknown age is not evidence of staleness");
});

async function board(issues, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-attention-"));
  const issuesPath = path.join(dir, "issues.json");
  await fs.writeFile(issuesPath, JSON.stringify(issues, null, 2));
  const config = resolveConfig({
    tracker: { kind: "local_json", provider: { path: issuesPath }, active_states: ["Ready", "In Progress", "Human Review"], terminal_states: ["Done"] },
    workspace: { root: path.join(dir, "workspaces") },
    agents: { noop: { command: "true" } },
    dispatch_guard: { require_git: false },
    notify: { enabled: false },
    ...extra
  }, dir);
  return new Orchestrator({ path: dir, dir, config, rawConfig: {}, promptTemplate: "x" }, logger);
}

const task = (id, folder) => ({
  id, identifier: `KAN-${id.split("-")[1]}`, title: "t", state: "Ready",
  labels: ["symphony"], dispatchable: true, agent: "noop", workspace_path: folder,
  updated_at: new Date().toISOString()
});

test("two tasks pointing at the same folder do not run at once", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-shared-"));
  const orchestrator = await board([task("local-1", folder), task("local-2", folder)]);
  orchestrator.scanSessions = async () => [];

  await orchestrator.poll();
  assert.equal(orchestrator.claims.size, 1, "a folder holds one worker at a time");
  await Promise.all([...orchestrator.claims.values()].map((c) => c.promise?.catch(() => {})));
});

test("a folder you already have a session open in is left alone", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-busy-"));
  const orchestrator = await board([task("local-1", folder)]);
  orchestrator.scanSessions = async () => [{ name: "claude", pid: "1", cwd: folder, at: new Date().toISOString() }];

  await orchestrator.poll();
  assert.equal(orchestrator.claims.size, 0);
  assert.match(orchestrator.guardRefused.get("local-1"), /claude session is already open/);
});

test("a stale session does not block dispatch", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-stale-"));
  const orchestrator = await board([task("local-1", folder)], { sessions: { stale_after_hours: 12 } });
  orchestrator.scanSessions = async () => [{ name: "claude", pid: "1", cwd: folder, at: hoursAgo(45) }];

  await orchestrator.poll();
  assert.equal(orchestrator.claims.size, 1, "a terminal left open for days should not block the work");
  await Promise.all([...orchestrator.claims.values()].map((c) => c.promise?.catch(() => {})));
});

test("a question answered straight away never raises an alert", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-quiet-"));
  const orchestrator = await board([{ ...task("local-1", folder), state: "Human Review", dispatchable: false }],
    {
      notify: { enabled: true, command: "true", after_waiting_ms: 60000 },
      sessions: { states: { working: "In Progress", idle: "Ready", waiting: "Human Review", ended: "Done" } }
    });

  const alerts = [];
  orchestrator.notifier.send = async (event, payload) => { alerts.push(event); return true; };
  orchestrator.waitingSince.set("local-1", Date.now());

  await orchestrator.alertOnStaleQuestions(await orchestrator.tracker.readIssues());
  assert.equal(alerts.length, 0, "sitting at the terminal, you already know");

  orchestrator.waitingSince.set("local-1", Date.now() - 120000);
  await orchestrator.alertOnStaleQuestions(await orchestrator.tracker.readIssues());
  assert.equal(alerts.length, 1, "a question left unanswered means you walked away");
});

test("a card that leaves the waiting state stops being tracked", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-left-"));
  const orchestrator = await board([{ ...task("local-1", folder), state: "In Progress", dispatchable: false }],
    {
      notify: { enabled: true, command: "true", after_waiting_ms: 1 },
      sessions: { states: { working: "In Progress", idle: "Ready", waiting: "Human Review", ended: "Done" } }
    });

  const alerts = [];
  orchestrator.notifier.send = async (event) => { alerts.push(event); return true; };
  orchestrator.waitingSince.set("local-1", Date.now() - 120000);

  await orchestrator.alertOnStaleQuestions(await orchestrator.tracker.readIssues());
  assert.equal(alerts.length, 0);
  assert.equal(orchestrator.waitingSince.has("local-1"), false);
});
