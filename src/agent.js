import { spawn } from "node:child_process";
import { makeId, nowIso, truncate } from "./utils.js";
import { renderPrompt } from "./workflow.js";

export class AgentRunner {
  constructor(config, workflow, tracker, workspaceManager, logger, onUpdate) {
    this.config = config;
    this.workflow = workflow;
    this.tracker = tracker;
    this.workspaceManager = workspaceManager;
    this.logger = logger;
    this.onUpdate = onUpdate;
  }

  async run(issue, attempt) {
    const workspace = await this.workspaceManager.prepare(issue);
    await this.workspaceManager.beforeRun(workspace.path);
    const threadId = makeId("thread");
    let currentIssue = issue;
    const selectedAgent = this.resolveAgent(issue);
    const liveSession = {
      agent: selectedAgent.name,
      agent_command: selectedAgent.command,
      session_id: null,
      thread_id: threadId,
      turn_id: null,
      codex_app_server_pid: null,
      last_codex_event: null,
      last_codex_timestamp: null,
      last_codex_message: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: 0
    };

    try {
      for (let turn = 1; turn <= this.config.agent.max_turns; turn += 1) {
        const turnId = makeId("turn");
        liveSession.turn_id = turnId;
        liveSession.session_id = `${threadId}-${turnId}`;
        liveSession.turn_count = turn;
        const prompt = renderPrompt(this.workflow.promptTemplate, currentIssue, attempt);
        await this.runTurn(currentIssue, prompt, attempt, turn, workspace.path, liveSession);

        const refreshed = await this.tracker.fetchIssuesByIds([currentIssue.id]);
        if (!refreshed.length) break;
        currentIssue = refreshed[0];
        const active = this.config.tracker.active_states.includes(String(currentIssue.state).trim().toLowerCase());
        if (!active || !currentIssue.dispatchable) break;
      }
      return { reason: "normal", workspace, liveSession };
    } finally {
      await this.workspaceManager.afterRun(workspace.path);
    }
  }

  runTurn(issue, prompt, attempt, turn, cwd, liveSession) {
    return new Promise((resolve, reject) => {
      const selectedAgent = this.resolveAgent(issue);
      const childEnv = this.buildChildEnv(issue, prompt, attempt, turn, selectedAgent);
      this.logger.event("info", "agent_selected", {
        issue_id: issue.id,
        identifier: issue.identifier,
        agent: selectedAgent.name,
        requested_agent: issue.agent ?? null,
        turn
      });
      const child = spawn("bash", ["-lc", selectedAgent.command], {
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"]
      });
      liveSession.codex_app_server_pid = String(child.pid ?? "");
      const startedAt = Date.now();
      let lastOutputAt = Date.now();
      let settled = false;
      const timeout = setTimeout(() => stop("turn timeout"), this.config.codex.turn_timeout_ms);
      const stall = this.config.codex.stall_timeout_ms > 0 ? setInterval(() => {
        if (Date.now() - lastOutputAt > this.config.codex.stall_timeout_ms) stop("stall timeout");
      }, Math.min(this.config.codex.stall_timeout_ms, 5000)) : null;

      const stop = (reason) => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        cleanup();
        reject(new Error(reason));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        if (stall) clearInterval(stall);
      };

      const handleOutput = (chunk, stream) => {
        lastOutputAt = Date.now();
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          const message = parseAgentLine(line, stream);
          updateLiveSession(liveSession, message);
          this.onUpdate(issue.id, liveSession);
          this.logger.event("info", "codex_update", { issue_id: issue.id, identifier: issue.identifier, ...message });
        }
      };

      child.stdout.on("data", (chunk) => handleOutput(chunk, "stdout"));
      child.stderr.on("data", (chunk) => handleOutput(chunk, "stderr"));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        const runtime_ms = Date.now() - startedAt;
        if (code === 0) {
          this.logger.event("info", "turn_completed", { issue_id: issue.id, identifier: issue.identifier, turn, runtime_ms });
          resolve();
        } else {
          reject(new Error(`agent command failed code=${code} signal=${signal}`));
        }
      });
    });
  }

  resolveAgent(issue) {
    const agents = this.config.agents || {};
    const requested = typeof issue.agent === "string" ? issue.agent.trim() : "";
    if (requested && agents[requested]) return { name: requested, command: agents[requested].command };
    if (requested) {
      this.logger.event("warn", "agent_not_found", {
        issue_id: issue.id,
        identifier: issue.identifier,
        requested_agent: requested,
        available: Object.keys(agents)
      });
    }
    const fallback = this.config.agent.default_agent;
    if (agents[fallback]) return { name: fallback, command: agents[fallback].command };
    return { name: "codex.command", command: this.config.codex.command };
  }

  buildChildEnv(issue, prompt, attempt, turn, selectedAgent = null) {
    const env = { ...process.env };
    for (const key of this.tracker.secretEnvNames || []) delete env[key];
    return {
      ...env,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
      SYMPHONY_TRACKER_KIND: this.config.tracker.kind,
      SYMPHONY_TRACKER_PATH: this.config.tracker.provider.path || "",
      SYMPHONY_ATTEMPT: attempt == null ? "" : String(attempt),
      SYMPHONY_TURN: String(turn),
      SYMPHONY_AGENT: selectedAgent?.name ?? "",
      SYMPHONY_ISSUE_TITLE: issue.title ?? "",
      SYMPHONY_ISSUE_STATE: issue.state ?? "",
      SYMPHONY_ISSUE_LABELS: (issue.labels || []).join(","),
      SYMPHONY_PROMPT: prompt
    };
  }
}

function parseAgentLine(line, stream) {
  try {
    const parsed = JSON.parse(line);
    return { stream, event: parsed.event || parsed.type || "message", message: truncate(parsed.message || line), input_tokens: parsed.input_tokens, output_tokens: parsed.output_tokens };
  } catch {
    return { stream, event: "message", message: truncate(line) };
  }
}

function updateLiveSession(session, message) {
  session.last_codex_event = message.event;
  session.last_codex_timestamp = nowIso();
  session.last_codex_message = message.message;
  if (Number.isFinite(message.input_tokens)) {
    session.last_reported_input_tokens = Number(message.input_tokens);
    session.codex_input_tokens += Number(message.input_tokens);
  }
  if (Number.isFinite(message.output_tokens)) {
    session.last_reported_output_tokens = Number(message.output_tokens);
    session.codex_output_tokens += Number(message.output_tokens);
  }
  session.last_reported_total_tokens = session.last_reported_input_tokens + session.last_reported_output_tokens;
  session.codex_total_tokens = session.codex_input_tokens + session.codex_output_tokens;
}
