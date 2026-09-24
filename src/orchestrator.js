import { AgentRunner } from "./agent.js";
import { createTracker, issueHasRequiredLabels } from "./tracker.js";
import { WorkspaceManager } from "./workspace.js";
import { normalizeState, nowIso, sleep } from "./utils.js";

export class Orchestrator {
  constructor(workflow, logger) {
    this.workflow = workflow;
    this.config = workflow.config;
    this.logger = logger;
    this.tracker = createTracker(this.config);
    this.workspaceManager = new WorkspaceManager(this.config, logger);
    this.runner = new AgentRunner(this.config, workflow, this.tracker, this.workspaceManager, logger, (issueId, liveSession) => {
      const claim = this.claims.get(issueId);
      if (claim) claim.codex_live_session = { ...liveSession };
    });
    this.claims = new Map();
    this.failures = new Map();
    this.running = false;
    this.loopPromise = null;
    this.lastPollAt = null;
    this.lastReloadAt = nowIso();
    this.dispatchHistory = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop() {
    this.running = false;
    await this.loopPromise;
  }

  async loop() {
    while (this.running) {
      try {
        await this.poll();
      } catch (error) {
        this.logger.event("error", "poll_failed", { error: error.message });
      }
      await sleep(this.config.polling.interval_ms);
    }
  }

  async poll() {
    this.lastPollAt = nowIso();
    await this.reconcileTerminalIssues();
    const candidates = await this.tracker.fetchCandidateIssues(this.config.tracker.active_states);
    const dispatchable = candidates
      .filter((issue) => issue.dispatchable)
      .filter((issue) => issueHasRequiredLabels(issue, this.config.tracker.required_labels))
      .filter((issue) => !this.claims.has(issue.id))
      .filter((issue) => this.retryAllowed(issue.id))
      .sort(compareIssues);

    for (const issue of dispatchable) {
      if (!this.canDispatch(issue)) continue;
      this.dispatch(issue);
    }
  }

  async runOnce() {
    await this.poll();
    await Promise.allSettled([...this.claims.values()].map((claim) => claim.promise));
  }

  dispatch(issue) {
    const attempt = (this.failures.get(issue.id)?.attempts || 0) + 1;
    const claim = {
      issue,
      issue_id: issue.id,
      identifier: issue.identifier,
      state: issue.state,
      claim_id: `${issue.id}:${Date.now()}`,
      attempt,
      claimed_at: nowIso(),
      heartbeat_at: nowIso(),
      status: "running",
      codex_live_session: null,
      promise: null
    };
    claim.promise = this.runner.run(issue, attempt)
      .then((result) => {
        this.dispatchHistory.push({ issue_id: issue.id, identifier: issue.identifier, finished_at: nowIso(), status: "completed", reason: result.reason });
        this.failures.delete(issue.id);
        this.logger.event("info", "issue_completed", { issue_id: issue.id, identifier: issue.identifier });
      })
      .catch((error) => {
        const record = this.failures.get(issue.id) || { attempts: 0, retry_after: null, last_error: null };
        record.attempts += 1;
        record.last_error = error.message;
        record.retry_after = new Date(Date.now() + this.retryBackoff(record.attempts)).toISOString();
        this.failures.set(issue.id, record);
        this.dispatchHistory.push({ issue_id: issue.id, identifier: issue.identifier, finished_at: nowIso(), status: "failed", error: error.message });
        this.logger.event("error", "issue_failed", { issue_id: issue.id, identifier: issue.identifier, attempts: record.attempts, retry_after: record.retry_after, error: error.message });
      })
      .finally(() => {
        this.claims.delete(issue.id);
      });
    this.claims.set(issue.id, claim);
    this.logger.event("info", "issue_claimed", { issue_id: issue.id, identifier: issue.identifier, claim_id: claim.claim_id, attempt });
  }

  canDispatch(issue) {
    if (this.claims.size >= this.config.agent.max_concurrent_agents) return false;
    const state = normalizeState(issue.state);
    const limit = this.config.agent.max_concurrent_agents_by_state[state];
    if (!limit) return true;
    let stateRunning = 0;
    for (const claim of this.claims.values()) {
      if (normalizeState(claim.state) === state) stateRunning += 1;
    }
    return stateRunning < limit;
  }

  retryAllowed(issueId) {
    const failure = this.failures.get(issueId);
    if (!failure?.retry_after) return true;
    return Date.parse(failure.retry_after) <= Date.now();
  }

  retryBackoff(attempts) {
    const delay = 1000 * 2 ** Math.min(attempts - 1, 8);
    return Math.min(delay, this.config.agent.max_retry_backoff_ms);
  }

  async reconcileTerminalIssues() {
    const runningIds = [...this.claims.keys()];
    if (!runningIds.length) return;
    const issues = await this.tracker.fetchIssuesByIds(runningIds);
    for (const issue of issues) {
      if (this.config.tracker.terminal_states.includes(normalizeState(issue.state))) {
        const claim = this.claims.get(issue.id);
        if (claim) {
          claim.status = "terminal";
          this.logger.event("info", "terminal_state_observed", { issue_id: issue.id, identifier: issue.identifier, state: issue.state });
        }
      }
    }
  }

  async release(issueId) {
    const claim = this.claims.get(issueId);
    if (!claim) return false;
    this.claims.delete(issueId);
    this.logger.event("info", "claim_released", { issue_id: issueId });
    return true;
  }

  async retry(issueId) {
    this.failures.delete(issueId);
    await this.poll();
  }

  snapshot() {
    return {
      workflow_path: this.workflow.path,
      tracker_kind: this.config.tracker.kind,
      running: this.running,
      last_poll_at: this.lastPollAt,
      last_reload_at: this.lastReloadAt,
      polling_interval_ms: this.config.polling.interval_ms,
      max_concurrent_agents: this.config.agent.max_concurrent_agents,
      claims: [...this.claims.values()].map(({ promise, ...claim }) => claim),
      failures: Object.fromEntries(this.failures),
      dispatch_history: this.dispatchHistory.slice(-50)
    };
  }
}

function compareIssues(a, b) {
  const priorityA = a.priority == null ? Number.MAX_SAFE_INTEGER : a.priority;
  const priorityB = b.priority == null ? Number.MAX_SAFE_INTEGER : b.priority;
  return priorityA - priorityB || String(a.created_at || "").localeCompare(String(b.created_at || "")) || a.identifier.localeCompare(b.identifier);
}
