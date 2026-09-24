import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import fsp from "node:fs/promises";
import { expandPathValue, normalizeState, uniqueLowerLabels } from "./utils.js";
import { scanExternalSessions } from "./sessions.js";

export function createServer(orchestrator, logger) {
  const publicDir = path.resolve(orchestrator.workflow.dir, "public");

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/api/config") return json(res, boardConfig(orchestrator));
      if (url.pathname === "/api/state") {
        // Sessions the user started themselves belong to a task too, so the board can
        // show a folder as busy even when Symphony did not dispatch the work.
        return json(res, { ...orchestrator.snapshot(), external_sessions: await scanExternalSessions() });
      }
      if (url.pathname === "/api/logs") return json(res, logger.recent.slice(-200));

      if (url.pathname === "/api/issues" && req.method === "GET") {
        return json(res, await orchestrator.tracker.readIssues());
      }

      if (url.pathname === "/api/issues" && req.method === "POST") {
        const created = await createIssue(orchestrator, await readJson(req));
        logger.event("info", "issue_created", { issue_id: created.id, identifier: created.identifier, agent: created.agent });
        return json(res, { ok: true, issue: created }, 201);
      }

      if (url.pathname === "/api/poll" && req.method === "POST") {
        await orchestrator.poll();
        return json(res, { ok: true });
      }

      if (url.pathname.startsWith("/api/issues/")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        if (!id) return json(res, { error: "issue id is required" }, 400);

        if (req.method === "PATCH") {
          const patch = await buildPatch(orchestrator, await readJson(req));
          const updated = await orchestrator.tracker.updateIssue(id, patch);
          if (!updated) return json(res, { error: `unknown issue: ${id}` }, 404);
          logger.event("info", "issue_updated", { issue_id: id, identifier: updated.identifier, fields: Object.keys(patch) });
          return json(res, { ok: true, issue: updated });
        }

        if (req.method === "DELETE") {
          const removed = await orchestrator.tracker.deleteIssue(id);
          if (!removed) return json(res, { error: `unknown issue: ${id}` }, 404);
          await orchestrator.forget(id);
          logger.event("info", "issue_deleted", { issue_id: id, identifier: removed.identifier });
          return json(res, { ok: true, issue: removed });
        }
      }

      if (url.pathname.startsWith("/api/retry/") && req.method === "POST") {
        await orchestrator.retry(decodeURIComponent(url.pathname.split("/").at(-1)));
        return json(res, { ok: true });
      }

      if (url.pathname.startsWith("/api/")) return json(res, { error: "not found" }, 404);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return file(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
      }
      const staticPath = path.normalize(path.join(publicDir, url.pathname));
      if (!staticPath.startsWith(publicDir)) return notFound(res);
      return file(res, staticPath, contentType(staticPath));
    } catch (error) {
      const status = error.status || (error.code === "invalid_request" ? 400 : 500);
      logger.event(status === 400 ? "warn" : "error", "http_request_failed", {
        method: req.method,
        path: url.pathname,
        error: error.message
      });
      return json(res, { error: error.message }, status);
    }
  });
}

function boardConfig(orchestrator) {
  const config = orchestrator.config;
  const raw = orchestrator.workflow.rawConfig?.tracker || {};
  const active = displayStates(raw.active_states, config.tracker.active_states);
  const terminal = displayStates(raw.terminal_states, config.tracker.terminal_states);
  return {
    states: [...active, ...terminal],
    active_states: active,
    terminal_states: terminal,
    required_labels: config.tracker.required_labels,
    default_agent: config.agent.default_agent,
    agents: Object.entries(config.agents).map(([name, definition]) => ({
      name,
      label: definition.label,
      description: definition.description
    })),
    polling_interval_ms: config.polling.interval_ms,
    tracker_kind: config.tracker.kind
  };
}

function displayStates(rawStates, normalized) {
  const source = Array.isArray(rawStates) && rawStates.length ? rawStates.map(String) : normalized;
  return [...new Set(source.map((state) => state.trim()).filter(Boolean))];
}

async function createIssue(orchestrator, body) {
  const config = orchestrator.config;
  const known = boardConfig(orchestrator);

  const title = String(body.title ?? "").trim();
  if (!title) throw invalid("title is required");

  const state = resolveRequestedState(body.state, known) ?? known.active_states[0];
  if (!state) throw invalid("no state available; check tracker.active_states in WORKFLOW.md");

  const agent = resolveRequestedAgent(body.agent, config);
  const workspacePath = await resolveWorkspacePath(body.workspace_path, orchestrator);
  const labels = uniqueLowerLabels([...(Array.isArray(body.labels) ? body.labels : []), ...config.tracker.required_labels]);

  return orchestrator.tracker.createIssue({
    title,
    description: body.description == null ? null : String(body.description),
    priority: body.priority,
    state,
    labels,
    agent,
    workspace_path: workspacePath,
    dispatchable: body.dispatchable === undefined ? true : Boolean(body.dispatchable)
  });
}

async function buildPatch(orchestrator, body) {
  const config = orchestrator.config;
  const known = boardConfig(orchestrator);
  const patch = {};

  if ("title" in body) {
    const title = String(body.title ?? "").trim();
    if (!title) throw invalid("title cannot be empty");
    patch.title = title;
  }
  if ("description" in body) patch.description = body.description == null ? null : String(body.description);
  if ("priority" in body) patch.priority = body.priority;
  if ("dispatchable" in body) patch.dispatchable = Boolean(body.dispatchable);
  if ("labels" in body) {
    if (!Array.isArray(body.labels)) throw invalid("labels must be an array");
    patch.labels = uniqueLowerLabels([...body.labels, ...config.tracker.required_labels]);
  }
  if ("agent" in body) patch.agent = resolveRequestedAgent(body.agent, config);
  if ("workspace_path" in body) patch.workspace_path = await resolveWorkspacePath(body.workspace_path, orchestrator);
  if ("state" in body) {
    const state = resolveRequestedState(body.state, known);
    if (!state) throw invalid(`unknown state: ${body.state}. known states: ${known.states.join(", ")}`);
    patch.state = state;
  }

  if (!Object.keys(patch).length) throw invalid("no updatable fields in request body");
  return patch;
}

function resolveRequestedState(requested, known) {
  if (requested == null || requested === "") return null;
  const wanted = normalizeState(requested);
  return known.states.find((state) => normalizeState(state) === wanted) ?? null;
}

// A task may name a folder the user already works in. It must already exist: this
// never creates a directory, so a typo surfaces as a 400 rather than a stray folder.
async function resolveWorkspacePath(requested, orchestrator) {
  if (requested == null || String(requested).trim() === "") return null;
  const expanded = expandPathValue(String(requested).trim(), orchestrator.workflow.dir);
  let stat;
  try {
    stat = await fsp.stat(expanded);
  } catch {
    throw invalid(`workspace_path does not exist: ${expanded}`);
  }
  if (!stat.isDirectory()) throw invalid(`workspace_path is not a directory: ${expanded}`);
  return expanded;
}

function resolveRequestedAgent(requested, config) {
  if (requested == null || requested === "") return null;
  const name = String(requested).trim();
  if (!config.agents[name]) {
    throw invalid(`unknown agent: ${name}. known agents: ${Object.keys(config.agents).join(", ")}`);
  }
  return name;
}

function invalid(message) {
  const error = new Error(message);
  error.code = "invalid_request";
  error.status = 400;
  return error;
}

function json(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value, null, 2));
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

async function file(res, filePath, type) {
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "content-type": type });
    res.end(content);
  } catch {
    notFound(res);
  }
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(invalid("request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}
