import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { LocalJsonTracker } from "../src/tracker.js";
import { resolveConfig } from "../src/workflow.js";
import {
  isChosenName, peersIn, readClaudeRegistry, readCodexNames, skillPrompt, validSessionName, validSkillUrl
} from "../src/peers.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();

test("messages in and out both make a peer, and only recent ones", () => {
  const records = [
    { type: "queue-operation", timestamp: ago(3), content: '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="market" from-mode="prompting">\nhi' },
    { type: "user", timestamp: ago(2), message: { content: '<cross-session-message from="uds:/tmp/x" from-name="market">again' } },
    { type: "assistant", timestamp: ago(1), message: { content: [{ type: "tool_use", name: "SendMessage", input: { to: "impl", message: "x" } }] } },
    { type: "assistant", timestamp: ago(90), message: { content: [{ type: "tool_use", name: "SendMessage", input: { to: "old-friend" } }] } },
    // The tool's own documentation shows an example call; it is not a conversation.
    { type: "attachment", timestamp: ago(1), attachment: { type: "deferred_tools_record", entries: [{ description: 'from-name="example"' }] } }
  ];
  assert.deepEqual(peersIn(records, NOW), [
    { name: "impl", at: ago(1), direction: "out" },
    { name: "market", at: ago(2), direction: "in" }
  ]);
});

test("a name Claude Code picked is not a registered one", () => {
  assert.equal(isChosenName("auto"), false);
  assert.equal(isChosenName("derived"), false);
  assert.equal(isChosenName(null), false);
  assert.equal(isChosenName("user"), true);
});

test("session names and skill links that could break out of the typed line are refused", () => {
  assert.equal(validSessionName(" symphony_market "), "symphony_market");
  assert.equal(validSessionName("지구 시뮬레이션-2"), "지구 시뮬레이션-2");
  assert.equal(validSessionName("a\n/clear"), null);
  assert.equal(validSessionName("/clear"), null);
  assert.equal(validSessionName('x"; do shell script "y'), null);
  assert.equal(validSessionName(""), null);

  const url = "https://github.com/emilkowalski/skills/blob/main/skills/apple-design/SKILL.md";
  assert.equal(validSkillUrl(url), url);
  assert.equal(validSkillUrl("https://github.com/coreyhaines31/marketingskills"), "https://github.com/coreyhaines31/marketingskills");
  assert.equal(validSkillUrl("https://evil.example/skills"), null);
  assert.equal(validSkillUrl(`${url} && rm -rf ~`), null);
  assert.equal(validSkillUrl("http://github.com/a/b"), null);
  assert.ok(skillPrompt(url).includes(url));
  assert.ok(!skillPrompt(url).includes("\n"));
});

test("names are read from both CLIs' own records", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-peers-"));
  const sessions = path.join(dir, "sessions");
  await fs.mkdir(sessions);
  await fs.writeFile(path.join(sessions, "101.json"), JSON.stringify({ pid: 101, sessionId: "s-1", name: "symphony_impl", nameSource: "user" }));
  await fs.writeFile(path.join(sessions, "102.json"), "{ half written");
  const index = path.join(dir, "session_index.jsonl");
  await fs.writeFile(index, [
    JSON.stringify({ id: "t-1", thread_name: "first", updated_at: ago(10) }),
    JSON.stringify({ id: "t-1", thread_name: "renamed", updated_at: ago(5) }),
    "{ partial"
  ].join("\n"));

  const registry = await readClaudeRegistry(sessions);
  assert.deepEqual(registry.get("101"), { session_name: "symphony_impl", name_source: "user", session_id: "s-1" });
  assert.equal(registry.size, 1);
  assert.equal((await readCodexNames(index)).get("t-1"), "renamed");
  assert.equal((await readClaudeRegistry(path.join(dir, "missing"))).size, 0);
});

test("another site cannot make the board type into a terminal", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-peers-"));
  const file = path.join(dir, "issues.json");
  await fs.writeFile(file, "[]");
  const config = resolveConfig({
    tracker: { kind: "local_json", provider: { path: file }, active_states: ["Ready"], terminal_states: ["Done"] },
    workspace: { root: path.join(dir, "workspaces") },
    sessions: { names: ["no-such-cli"] }
  }, dir);
  const logger = { event() {}, recent: [] };
  const server = createServer({ config, tracker: new LocalJsonTracker(file), logger, workflow: { dir: path.resolve("."), rawConfig: {} } }, logger);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) => fetch(`${base}${route}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  });

  try {
    assert.equal((await post("/api/sessions/rename", { pid: "1", name: "x" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/api/sessions/skill", { url: "https://github.com/a/b", pids: ["1"] }, { origin: "null" })).status, 403);
    const plain = await fetch(`${base}/api/sessions/rename`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"pid":"1","name":"x"}' });
    assert.equal(plain.status, 400);
    assert.equal((await post("/api/sessions/rename", { pid: "1", name: "/clear" })).status, 400);
    // A pid the board cannot see is never typed into.
    assert.equal((await post("/api/sessions/rename", { pid: "999999", name: "fine" })).status, 400);
    const skill = await (await post("/api/sessions/skill", { url: "https://github.com/a/b", pids: ["999999"] })).json();
    assert.equal(skill.ok, false);
    assert.match(skill.results[0].error, /no running session/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
