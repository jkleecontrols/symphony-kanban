import test from "node:test";
import assert from "node:assert/strict";
import { currentAgent } from "../public/current-agent.js";

test("active session overrides saved automatic-dispatch agent", () => {
  assert.equal(currentAgent({ agent: "claude" }, null, [
    { name: "codex", phase: "working", at: "2026-10-13T12:00:00Z" }
  ]), "codex");
});

test("active claim takes precedence over external sessions", () => {
  assert.equal(currentAgent({ agent: "claude" }, {
    codex_live_session: { agent: "goose" }
  }, [{ name: "codex", phase: "working" }]), "goose");
});

test("most active session wins and saved agent is the fallback", () => {
  const issue = { agent: "claude" };
  assert.equal(currentAgent(issue, null, [
    { name: "aider", phase: "idle", at: "2026-10-13T13:00:00Z" },
    { name: "codex", phase: "working", at: "2026-10-13T12:00:00Z" }
  ]), "codex");
  assert.equal(currentAgent(issue, null, []), "claude");
});
