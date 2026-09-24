import test from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow, renderPrompt, resolveConfig } from "../src/workflow.js";
import { assertPathInside, sanitizeWorkspaceKey } from "../src/utils.js";

test("parses workflow front matter and prompt", () => {
  const parsed = parseWorkflow(`---
tracker:
  kind: local_json
  provider:
    path: data/issues.json
  active_states:
    - Ready
  terminal_states:
    - Done
agent:
  max_concurrent_agents_by_state:
    Ready: 1
---
Hello {{ issue.identifier }}`);
  assert.equal(parsed.rawConfig.tracker.kind, "local_json");
  assert.equal(parsed.rawConfig.agent.max_concurrent_agents_by_state.Ready, 1);
  assert.equal(parsed.promptTemplate, "Hello {{ issue.identifier }}");
});

test("resolves config defaults and normalizes states", () => {
  const config = resolveConfig({
    tracker: {
      kind: "local_json",
      provider: { path: "issues.json" },
      active_states: ["Ready"],
      terminal_states: ["Done"],
      required_labels: ["Symphony"]
    }
  }, "/tmp/workflow");
  assert.equal(config.tracker.active_states[0], "ready");
  assert.equal(config.tracker.required_labels[0], "symphony");
  assert.equal(config.polling.interval_ms, 30000);
});

test("template rendering is strict", () => {
  assert.equal(renderPrompt("{{ issue.identifier }} #{{ attempt }}", { identifier: "KAN-1" }, 2), "KAN-1 #2");
  assert.throws(() => renderPrompt("{{ issue.missing }}", { identifier: "KAN-1" }, 2), /unknown variable/);
});

test("workspace keys are sanitized and paths stay inside root", () => {
  const key = sanitizeWorkspaceKey("../KAN 1");
  assert.match(key, /^\.\._KAN_1_/);
  assert.throws(() => assertPathInside("/tmp/root", "/tmp/root2/escape"), /escapes/);
});
