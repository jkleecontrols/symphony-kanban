import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import fsp from "node:fs/promises";
import { expandPathValue, normalizeState, uniqueLowerLabels } from "./utils.js";
import { scanExternalSessions, sessionsForPath } from "./sessions.js";
import { suggestCommand } from "./verify.js";
import { canReplyTo, sendReply } from "./reply.js";
import { isStale } from "./sessions.js";
import { readActivity } from "./transcripts.js";

export function createServer(orchestrator, logger) {
  const publicDir = path.resolve(orchestrator.workflow.dir, "public");

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      // Spec section 17: the conformant operator surface.
      if (url.pathname === "/api/v1/state") return json(res, await stateOf(orchestrator));
      if (url.pathname === "/api/v1/refresh" && req.method === "POST") {
        await orchestrator.poll();
        return json(res, { ok: true, last_poll_at: orchestrator.lastPollAt });
      }
      if (url.pathname.startsWith("/api/v1/")) {
        const identifier = decodeURIComponent(url.pathname.slice("/api/v1/".length));
        const detail = await issueDetail(orchestrator, identifier);
        if (!detail) return fail(res, 404, "issue_not_found", `no issue with identifier ${identifier}`);
        return json(res, detail);
      }

      if (url.pathname === "/api/config") return json(res, boardConfig(orchestrator));
      if (url.pathname === "/api/suggest-verify") {
        const folder = url.searchParams.get("path") || "";
        return json(res, { command: await suggestFor(orchestrator, folder) });
      }
      if (url.pathname === "/api/state") {
        // Sessions the user started themselves belong to a task too, so the board can
        // show a folder as busy even when Symphony did not dispatch the work.
        const names = orchestrator.config.sessions.names;
        return json(res, {
          ...orchestrator.snapshot(),
          external_sessions: await scanExternalSessions(names.length ? names : undefined)
        });
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
        if (!id) return fail(res, 400, "invalid_request", "issue id is required");
        if (url.pathname.endsWith("/reply") && req.method !== "POST") {
          return fail(res, 404, "not_found", "reply takes POST");
        }

        if (req.method === "PATCH") {
          const patch = await buildPatch(orchestrator, await readJson(req));
          const updated = await orchestrator.tracker.updateIssue(id, patch);
          if (!updated) return fail(res, 404, "issue_not_found", `unknown issue: ${id}`);
          logger.event("info", "issue_updated", { issue_id: id, identifier: updated.identifier, fields: Object.keys(patch) });
          return json(res, { ok: true, issue: updated });
        }

        if (url.pathname.endsWith("/reply") && req.method === "POST") {
          const replyId = decodeURIComponent(url.pathname.split("/")[3] || "");
          return json(res, await replyToSession(orchestrator, replyId, await readJson(req)));
        }

        if (req.method === "DELETE") {
          const removed = await orchestrator.tracker.deleteIssue(id);
          if (!removed) return fail(res, 404, "issue_not_found", `unknown issue: ${id}`);
          await orchestrator.forget(id);
          logger.event("info", "issue_deleted", { issue_id: id, identifier: removed.identifier });
          return json(res, { ok: true, issue: removed });
        }
      }

      if (url.pathname.startsWith("/api/retry/") && req.method === "POST") {
        await orchestrator.retry(decodeURIComponent(url.pathname.split("/").at(-1)));
        return json(res, { ok: true });
      }

      if (url.pathname.startsWith("/api/")) return fail(res, 404, "not_found", `no route for ${req.method} ${url.pathname}`);

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
      return fail(res, status, error.code === "invalid_request" || error.code === "issue_not_found" ? error.code : "internal_error", error.message);
    }
  });
}

// Answering from the board resumes the conversation in a new process. Beside an open
// terminal that is the collision this project already hit once, so the board shows the
// question but refuses to send until the session is closed.
async function replyToSession(orchestrator, issueId, body) {
  const config = orchestrator.config;
  if (!config.reply.enabled) throw invalid("replying is disabled in WORKFLOW.md");

  const answer = String(body.answer ?? "").trim();
  if (!answer) throw invalid("an answer is required");

  const issues = await orchestrator.tracker.readIssues();
  const issue = issues.find((candidate) => candidate.id === issueId);
  if (!issue) throw notFoundError(`unknown issue: ${issueId}`);
  if (!issue.workspace_path) throw invalid("this task has no project folder to reply into");

  const names = config.sessions.names;
  const sessions = await scanExternalSessions(names.length ? names : undefined);
  const live = sessionsForPath(sessions, issue.workspace_path)
    .filter((session) => !isStale(session, config.sessions.stale_after_hours));
  if (live.length) {
    throw invalid(`a ${live[0].name} session is still open in this folder — answer it there, or close it first`);
  }

  const agent = String(body.agent || issue.agent || "claude");
  if (!canReplyTo(agent)) throw invalid(`cannot resume a ${agent} session`);

  const history = await readActivity({ name: agent, cwd: issue.workspace_path });
  const sessionId = body.session_id || history?.session_id;
  if (!sessionId) throw invalid(`no ${agent} session found for ${issue.workspace_path}`);

  const result = await sendReply({
    agent,
    sessionId,
    cwd: issue.workspace_path,
    answer,
    timeoutMs: config.reply.timeout_ms
  });

  const record = { at: new Date().toISOString(), agent, session_id: sessionId, answer, ...result };
  await orchestrator.tracker.updateIssue(issue.id, { last_reply: record });
  orchestrator.notifier.forget(issue.id);
  orchestrator.waitingSince.delete(issue.id);
  return { ok: result.ok, reply: record };
}

function notFoundError(message) {
  const error = new Error(message);
  error.code = "issue_not_found";
  error.status = 404;
  return error;
}

async function suggestFor(orchestrator, folder) {
  if (!folder.trim()) return null;
  try {
    const expanded = expandPathValue(folder.trim(), orchestrator.workflow.dir);
    return suggestCommand(await fsp.readdir(expanded));
  } catch {
    return null;
  }
}

async function stateOf(orchestrator) {
  const names = orchestrator.config.sessions.names;
  return {
    ...orchestrator.snapshot(),
    external_sessions: await scanExternalSessions(names.length ? names : undefined)
  };
}

async function issueDetail(orchestrator, identifier) {
  const wanted = identifier.trim().toLowerCase();
  const issues = await orchestrator.tracker.readIssues();
  const issue = issues.find((candidate) => candidate.identifier.toLowerCase() === wanted);
  if (!issue) return null;
  const claim = orchestrator.claims.get(issue.id);
  const names = orchestrator.config.sessions.names;
  const sessions = await scanExternalSessions(names.length ? names : undefined);
  return {
    issue,
    claim: claim ? { ...claim, promise: undefined } : null,
    failure: orchestrator.failures.get(issue.id) || null,
    external_sessions: sessionsForPath(sessions, issue.workspace_path),
    dispatch_history: orchestrator.snapshot().dispatch_history.filter((entry) => entry.issue_id === issue.id)
  };
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
    verify_enabled: config.verify.enabled,
    default_verify_command: config.verify.command,
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
    verify_command: body.verify_command == null || String(body.verify_command).trim() === "" ? null : String(body.verify_command).trim(),
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
  if ("verify_command" in body) {
    const command = body.verify_command == null ? "" : String(body.verify_command).trim();
    patch.verify_command = command || null;
  }
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

// Spec section 17: errors carry {"error":{"code","message"}}.
function fail(res, status, code, message) {
  return json(res, { error: { code, message } }, status);
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
