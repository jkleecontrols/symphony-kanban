import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalJsonTracker, normalizeIssue } from "../src/tracker.js";

async function freshTracker(seed = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-tracker-"));
  const file = path.join(dir, "issues.json");
  await fs.writeFile(file, `${JSON.stringify(seed, null, 2)}\n`);
  return new LocalJsonTracker(file);
}

test("createIssue generates sequential id and identifier", async () => {
  const tracker = await freshTracker([
    { id: "local-1", identifier: "KAN-101", title: "old", state: "Done", labels: [] }
  ]);

  const created = await tracker.createIssue({ title: "New task", state: "Ready", labels: ["symphony"], dispatchable: true });
  assert.equal(created.id, "local-2");
  assert.equal(created.identifier, "KAN-102");
  assert.equal(created.title, "New task");
  assert.deepEqual(created.labels, ["symphony"]);
  assert.equal(created.dispatchable, true);
  assert.ok(created.created_at);

  const onDisk = await tracker.readIssues();
  assert.equal(onDisk.length, 2);
});

test("createIssue requires a title and a state", async () => {
  const tracker = await freshTracker();
  await assert.rejects(() => tracker.createIssue({ title: "   ", state: "Ready" }), /title is required/);
  await assert.rejects(() => tracker.createIssue({ title: "ok" }), /state is required/);
});

test("createIssue rejects a duplicate identifier", async () => {
  const tracker = await freshTracker([
    { id: "local-1", identifier: "KAN-101", title: "old", state: "Ready", labels: [] }
  ]);
  await assert.rejects(
    () => tracker.createIssue({ title: "dup", state: "Ready", identifier: "KAN-101" }),
    /identifier already exists/
  );
});

test("agent field survives a round trip through normalizeIssue", async () => {
  const tracker = await freshTracker();
  const created = await tracker.createIssue({ title: "route me", state: "Ready", agent: "omniroute" });
  assert.equal(created.agent, "omniroute");
  const [reloaded] = await tracker.readIssues();
  assert.equal(reloaded.agent, "omniroute");
  assert.equal(normalizeIssue({ id: "x", identifier: "X-1", state: "Ready" }).agent, null);
});

test("updateIssue patches whitelisted fields only and bumps updated_at", async () => {
  const tracker = await freshTracker([
    { id: "local-1", identifier: "KAN-101", title: "before", state: "Ready", labels: [], updated_at: "2020-01-01T00:00:00.000Z" }
  ]);

  const updated = await tracker.updateIssue("local-1", {
    title: "after",
    state: "In Progress",
    agent: "claude",
    priority: 2,
    labels: ["Symphony", "symphony", "Docs"],
    dispatchable: true,
    id: "hacked",
    identifier: "HACKED-1",
    created_at: "1999-01-01T00:00:00.000Z"
  });

  assert.equal(updated.title, "after");
  assert.equal(updated.state, "In Progress");
  assert.equal(updated.agent, "claude");
  assert.equal(updated.priority, 2);
  assert.deepEqual(updated.labels, ["symphony", "docs"]);
  assert.equal(updated.id, "local-1", "id must not be patchable");
  assert.equal(updated.identifier, "KAN-101", "identifier must not be patchable");
  assert.notEqual(updated.updated_at, "2020-01-01T00:00:00.000Z");
});

test("updateIssueState still works for the orchestrator", async () => {
  const tracker = await freshTracker([
    { id: "local-1", identifier: "KAN-101", title: "t", state: "Ready", labels: [] }
  ]);
  const updated = await tracker.updateIssueState("local-1", "Done");
  assert.equal(updated.state, "Done");
  assert.equal(await tracker.updateIssueState("missing", "Done"), null);
});

test("updateIssue rejects blanking the title", async () => {
  const tracker = await freshTracker([
    { id: "local-1", identifier: "KAN-101", title: "keep me", state: "Ready", labels: [] }
  ]);
  await assert.rejects(() => tracker.updateIssue("local-1", { title: "  " }), /title is required/);
  const [issue] = await tracker.readIssues();
  assert.equal(issue.title, "keep me", "a rejected update must not be written to disk");
});

test("deleteIssue removes one issue and returns null when missing", async () => {
  const tracker = await freshTracker([
    { id: "local-1", identifier: "KAN-101", title: "a", state: "Ready", labels: [] },
    { id: "local-2", identifier: "KAN-102", title: "b", state: "Ready", labels: [] }
  ]);

  const removed = await tracker.deleteIssue("local-1");
  assert.equal(removed.identifier, "KAN-101");
  const remaining = await tracker.readIssues();
  assert.deepEqual(remaining.map((issue) => issue.id), ["local-2"]);
  assert.equal(await tracker.deleteIssue("local-1"), null);
});

test("concurrent creates are serialized by the file lock", async () => {
  const tracker = await freshTracker();
  await Promise.all(Array.from({ length: 8 }, (_, i) => tracker.createIssue({ title: `t${i}`, state: "Ready" })));
  const issues = await tracker.readIssues();
  assert.equal(issues.length, 8);
  assert.equal(new Set(issues.map((issue) => issue.id)).size, 8, "ids must be unique");
  assert.equal(new Set(issues.map((issue) => issue.identifier)).size, 8, "identifiers must be unique");
});
