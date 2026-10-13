import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { LocalJsonTracker } from "../src/tracker.js";
import { resolveConfig } from "../src/workflow.js";

test("dependency arrows persist and cannot create a cycle", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-graph-"));
  const file = path.join(dir, "issues.json");
  await fs.writeFile(file, JSON.stringify([
    { id: "local-1", identifier: "KAN-1", title: "A", state: "Ready", blocked_by: [], dispatchable: false },
    { id: "local-2", identifier: "KAN-2", title: "B", state: "Ready", blocked_by: [], dispatchable: false }
  ]));
  const tracker = new LocalJsonTracker(file);
  const config = resolveConfig({
    tracker: { kind: "local_json", provider: { path: file }, active_states: ["Ready"], terminal_states: ["Done"] },
    workspace: { root: path.join(dir, "workspaces") }
  }, dir);
  const server = createServer({ config, tracker, workflow: { dir: path.resolve("."), rawConfig: {} } }, { event() {}, recent: [] });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const patch = (id, blocked_by) => fetch(`${base}/api/issues/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocked_by })
  });

  try {
    assert.equal((await patch("local-2", ["local-1"])).status, 200);
    let issues = await tracker.readIssues();
    assert.deepEqual(issues[1].blocked_by, [{ id: "local-1", identifier: "KAN-1", state: "Ready" }]);
    assert.equal((await patch("local-1", ["local-2"])).status, 400);
    assert.equal((await patch("local-2", ["local-2"])).status, 400);
    assert.equal((await patch("local-2", ["missing"])).status, 400);
    assert.equal((await patch("local-2", [])).status, 200);
    issues = await tracker.readIssues();
    assert.deepEqual(issues[1].blocked_by, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
