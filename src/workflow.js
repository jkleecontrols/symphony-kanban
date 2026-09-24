import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expandPathValue, normalizeLabel, normalizeState, resolveEnvRef } from "./utils.js";

export async function loadWorkflow(workflowPath) {
  const resolved = path.resolve(workflowPath || "WORKFLOW.md");
  let source;
  try {
    source = await fs.readFile(resolved, "utf8");
  } catch (error) {
    const err = new Error(`missing workflow file: ${resolved}`);
    err.code = "missing_workflow_file";
    err.cause = error;
    throw err;
  }

  const { rawConfig, promptTemplate } = parseWorkflow(source);
  const config = resolveConfig(rawConfig, path.dirname(resolved));
  return { path: resolved, dir: path.dirname(resolved), config, rawConfig, promptTemplate };
}

export function parseWorkflow(source) {
  if (!source.startsWith("---")) return { rawConfig: {}, promptTemplate: source.trim() };
  const lines = source.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    const err = new Error("workflow_parse_error: missing closing front matter marker");
    err.code = "workflow_parse_error";
    throw err;
  }
  const rawConfig = parseSimpleYaml(lines.slice(1, end).join("\n"));
  if (!rawConfig || Array.isArray(rawConfig) || typeof rawConfig !== "object") {
    const err = new Error("workflow_front_matter_not_a_map");
    err.code = "workflow_front_matter_not_a_map";
    throw err;
  }
  return { rawConfig, promptTemplate: lines.slice(end + 1).join("\n").trim() };
}

export function resolveConfig(raw, workflowDir, env = process.env) {
  const tracker = raw.tracker || {};
  const polling = raw.polling || {};
  const workspace = raw.workspace || {};
  const hooks = raw.hooks || {};
  const agent = raw.agent || {};
  const codex = raw.codex || {};

  const provider = Object.fromEntries(Object.entries(tracker.provider || {}).map(([key, value]) => {
    if (key === "path" || key.endsWith("_path")) return [key, expandPathValue(resolveEnvRef(value, env), workflowDir, env)];
    return [key, resolveEnvRef(value, env)];
  }));

  const fallbackCommand = codex.command || "codex app-server";
  const agents = normalizeAgents(raw.agents, fallbackCommand);
  const defaultAgent = pickDefaultAgent(agent.default_agent, agents);

  const resolved = {
    agents,
    tracker: {
      kind: tracker.kind || "",
      provider,
      required_labels: arrayOfStrings(tracker.required_labels).map(normalizeLabel).filter(Boolean),
      active_states: arrayOfStrings(tracker.active_states).map(normalizeState).filter(Boolean),
      terminal_states: arrayOfStrings(tracker.terminal_states).map(normalizeState).filter(Boolean)
    },
    polling: {
      interval_ms: positiveInteger(polling.interval_ms, 30000)
    },
    workspace: {
      root: expandPathValue(workspace.root || path.join(os.tmpdir(), "symphony_workspaces"), workflowDir, env)
    },
    hooks: {
      after_create: stringOrNull(hooks.after_create),
      before_run: stringOrNull(hooks.before_run),
      after_run: stringOrNull(hooks.after_run),
      before_remove: stringOrNull(hooks.before_remove),
      timeout_ms: positiveInteger(hooks.timeout_ms, 60000)
    },
    agent: {
      max_concurrent_agents: positiveInteger(agent.max_concurrent_agents, 10),
      max_turns: positiveInteger(agent.max_turns, 20),
      max_retry_backoff_ms: positiveInteger(agent.max_retry_backoff_ms, 300000),
      max_concurrent_agents_by_state: normalizeStateLimits(agent.max_concurrent_agents_by_state),
      default_agent: defaultAgent
    },
    codex: {
      command: codex.command || "codex app-server",
      approval_policy: codex.approval_policy,
      thread_sandbox: codex.thread_sandbox,
      turn_sandbox_policy: codex.turn_sandbox_policy,
      turn_timeout_ms: positiveInteger(codex.turn_timeout_ms, 3600000),
      read_timeout_ms: positiveInteger(codex.read_timeout_ms, 5000),
      stall_timeout_ms: integer(codex.stall_timeout_ms, 300000)
    }
  };

  validateConfig(resolved);
  return resolved;
}

export function renderPrompt(template, issue, attempt) {
  const source = template || "You are working on an issue from the configured tracker.";
  return source.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    const value = resolveTemplatePath({ issue, attempt }, expr.trim());
    if (value === undefined) {
      const err = new Error(`template_render_error: unknown variable ${expr.trim()}`);
      err.code = "template_render_error";
      throw err;
    }
    if (Array.isArray(value)) return value.join(", ");
    if (value && typeof value === "object") return JSON.stringify(value);
    if (value === null) return "";
    return String(value);
  });
}

function resolveTemplatePath(scope, expr) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(expr)) {
    const err = new Error(`template_parse_error: unsupported expression ${expr}`);
    err.code = "template_parse_error";
    throw err;
  }
  return expr.split(".").reduce((obj, key) => (obj == null ? undefined : obj[key]), scope);
}

function validateConfig(config) {
  const errors = [];
  if (!config.tracker.kind) errors.push("tracker.kind is required");
  if (!config.tracker.active_states.length) errors.push("tracker.active_states is required");
  if (!config.tracker.terminal_states.length) errors.push("tracker.terminal_states is required");
  if (config.tracker.kind !== "local_json") errors.push(`unsupported tracker.kind: ${config.tracker.kind}`);
  if (config.tracker.kind === "local_json" && !config.tracker.provider.path) errors.push("tracker.provider.path is required for local_json");
  if (config.codex.stall_timeout_ms == null || Number.isNaN(config.codex.stall_timeout_ms)) errors.push("codex.stall_timeout_ms must be an integer");
  if (!Object.keys(config.agents).length) errors.push("agents must define at least one agent with a command");
  if (!config.agents[config.agent.default_agent]) errors.push(`agent.default_agent is not defined in agents: ${config.agent.default_agent}`);
  if (errors.length) {
    const err = new Error(`workflow_parse_error: ${errors.join("; ")}`);
    err.code = "workflow_parse_error";
    throw err;
  }
}

function parseSimpleYaml(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^ */)[0].length;
    const text = raw.trim();
    while (stack.length && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;

    if (text.startsWith("- ")) {
      if (!Array.isArray(parent)) throw yamlError(i, "list item without list parent");
      parent.push(parseScalar(text.slice(2)));
      continue;
    }

    const match = text.match(/^([^:]+):(.*)$/);
    if (!match) throw yamlError(i, "expected key: value");
    const key = match[1].trim();
    let rest = match[2].trimStart();
    if (rest === "|") {
      const block = [];
      const blockIndent = nextContentIndent(lines, i + 1);
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const nextIndent = next.match(/^ */)[0].length;
        if (next.trim() && nextIndent < blockIndent) break;
        i += 1;
        block.push(next.slice(Math.min(blockIndent, next.length)));
      }
      parent[key] = block.join("\n").replace(/\n$/, "");
    } else if (rest === "") {
      const next = nextMeaningfulLine(lines, i + 1);
      const child = next?.trim().startsWith("- ") ? [] : {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseScalar(rest);
    }
  }
  return root;
}

function parseScalar(text) {
  if (text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    const body = text.slice(1, -1).trim();
    return body ? body.split(",").map((item) => parseScalar(item.trim())) : [];
  }
  return text.replace(/^["']|["']$/g, "");
}

function yamlError(line, message) {
  const err = new Error(`workflow_parse_error:${line + 1}: ${message}`);
  err.code = "workflow_parse_error";
  return err;
}

function nextMeaningfulLine(lines, start) {
  return lines.slice(start).find((line) => line.trim() && !line.trim().startsWith("#"));
}

function nextContentIndent(lines, start) {
  const line = nextMeaningfulLine(lines, start);
  return line ? line.match(/^ */)[0].length : 0;
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function integer(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) ? number : fallback;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeAgents(value, fallbackCommand) {
  const agents = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [rawName, definition] of Object.entries(value)) {
      const name = String(rawName).trim();
      if (!name) continue;
      const command = typeof definition === "string" ? definition : definition?.command;
      if (typeof command !== "string" || !command.trim()) continue;
      agents[name] = {
        command: command.trim(),
        label: typeof definition?.label === "string" && definition.label.trim() ? definition.label.trim() : name,
        description: typeof definition?.description === "string" ? definition.description : null
      };
    }
  }
  if (!Object.keys(agents).length) {
    agents.default = { command: fallbackCommand, label: "default", description: "falls back to codex.command" };
  }
  return agents;
}

function pickDefaultAgent(requested, agents) {
  const name = typeof requested === "string" ? requested.trim() : "";
  if (name) return name;
  return Object.keys(agents)[0] || "";
}

function normalizeStateLimits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, limit]) => [normalizeState(key), Number(limit)])
    .filter(([key, limit]) => key && Number.isInteger(limit) && limit > 0));
}
