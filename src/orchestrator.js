import { AgentRunner } from "./agent.js";
import { createTracker, issueHasRequiredLabels } from "./tracker.js";
import { WorkspaceManager } from "./workspace.js";
import { normalizeState, nowIso, sleep } from "./utils.js";
import { scanExternalSessions, sessionsForPath } from "./sessions.js";
import { changesSince, inspect } from "./gitguard.js";

// The busiest session in a folder decides the card: one turn running anywhere in it
// means the task is in progress.
function phaseOf(sessions) {
  const phases = sessions.map((session) => session.phase).filter(Boolean);
  if (phases.includes("working")) return "working";
  if (phases.includes("waiting")) return "waiting";
  return "idle";
}

// Spec section 3 run-attempt terminal statuses.
function terminalStatusFor(error) {
  if (error?.code === "canceled_by_reconciliation") return "CanceledByReconciliation";
  if (error?.code === "turn_timeout") return "TimedOut";
  if (error?.code === "stall_timeout") return "Stalled";
  return "Failed";
}

export class Orchestrator {
  constructor(workflow, logger) {
    this.workflow = workflow;
    this.config = workflow.config;
    this.logger = logger;
    this.tracker = createTracker(this.config);
    this.workspaceManager = new WorkspaceManager(this.config, logger);
    this.runner = new AgentRunner(this.config, workflow, this.tracker, this.workspaceManager, logger, (issueId, update) => {
      const claim = this.claims.get(issueId);
      if (!claim) return;
      if (update.phase && claim.status !== "Canceling") claim.status = update.phase;
      claim.codex_live_session = { ...(claim.codex_live_session || {}), ...update };
      claim.heartbeat_at = nowIso();
    });
    this.claims = new Map();
    this.failures = new Map();
    this.running = false;
    this.loopPromise = null;
    this.lastPollAt = null;
    this.lastReloadAt = nowIso();
    this.dispatchHistory = [];
    // Folders where a session of the user's own was seen, and how many polls it has been gone.
    this.externalWatch = new Map();
    // Spec section 4: aggregate agent usage across the process lifetime.
    this.codexTotals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, runtime_seconds: 0, turns: 0, runs: 0 };
    // Injectable so tests can drive the watcher without real processes.
    this.scanSessions = scanExternalSessions;
    // Issues already refused by the dispatch guard, so the reason is logged once.
    this.guardRefused = new Map();
    this.lastChanges = new Map();
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
    await this.cleanupTerminalWorkspaces();
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
    await this.reconcile();
    await this.watchExternalSessions();
    await this.sweepArchive();
    const candidates = await this.tracker.fetchCandidateIssues(this.config.tracker.active_states);
    const dispatchable = candidates
      .filter((issue) => issue.dispatchable)
      .filter((issue) => issueHasRequiredLabels(issue, this.config.tracker.required_labels))
      .filter((issue) => !this.claims.has(issue.id))
      .filter((issue) => this.retryAllowed(issue.id))
      .sort(compareIssues);

    for (const issue of dispatchable) {
      if (!this.canDispatch(issue)) continue;
      const baseline = await this.guardBaseline(issue);
      if (!baseline) continue;
      this.dispatch(issue, baseline);
    }
  }

  // Auto-dispatch writes with nobody watching, so the folder must be recoverable first.
  async guardBaseline(issue) {
    if (!this.config.dispatch_guard.require_git) return { git: false, skipped: true };
    const state = await inspect(issue.workspace_path);
    if (state.git) {
      this.guardRefused.delete(issue.id);
      return state;
    }
    if (this.guardRefused.get(issue.id) !== state.reason) {
      this.guardRefused.set(issue.id, state.reason);
      this.logger.event("warn", "dispatch_refused", {
        issue_id: issue.id,
        identifier: issue.identifier,
        reason: state.reason
      });
    }
    return null;
  }

  async sweepArchive() {
    const settings = this.config.archive;
    if (!settings.enabled || !settings.from_state || !settings.to_state) return;
    if (!Number.isFinite(settings.after_days) || settings.after_days < 0) return;

    const cutoff = Date.now() - settings.after_days * 86400000;
    let issues;
    try {
      issues = await this.tracker.readIssues();
    } catch (error) {
      this.logger.event("warn", "archive_sweep_failed", { error: error.message });
      return;
    }

    for (const issue of issues) {
      if (normalizeState(issue.state) !== normalizeState(settings.from_state)) continue;
      const touched = Date.parse(issue.updated_at);
      if (!Number.isFinite(touched) || touched > cutoff) continue;
      try {
        await this.tracker.updateIssueState(issue.id, settings.to_state);
        this.logger.event("info", "auto_archived", {
          issue_id: issue.id,
          identifier: issue.identifier,
          idle_days: Math.floor((Date.now() - touched) / 86400000),
          to: settings.to_state
        });
      } catch (error) {
        this.logger.event("warn", "archive_failed", { issue_id: issue.id, error: error.message });
      }
    }
  }

  async runOnce() {
    await this.poll();
    await Promise.allSettled([...this.claims.values()].map((claim) => claim.promise));
  }

  dispatch(issue, baseline = null) {
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
      status: "PreparingWorkspace",
      codex_live_session: null,
      promise: null
    };
    claim.promise = this.runner.run(issue, attempt)
      .then(async (result) => {
        claim.status = "Succeeded";
        await this.recordChanges(issue, baseline);
        this.recordUsage(result.liveSession, claim);
        this.dispatchHistory.push({ issue_id: issue.id, identifier: issue.identifier, finished_at: nowIso(), status: "Succeeded", reason: result.reason });
        this.failures.delete(issue.id);
        this.logger.event("info", "issue_completed", { issue_id: issue.id, identifier: issue.identifier });
      })
      .catch((error) => {
        claim.status = terminalStatusFor(error);
        this.recordUsage(claim.codex_live_session, claim);
        if (error?.code === "canceled_by_reconciliation") {
          this.dispatchHistory.push({ issue_id: issue.id, identifier: issue.identifier, finished_at: nowIso(), status: claim.status, reason: error.message });
          this.logger.event("info", "issue_canceled", { issue_id: issue.id, identifier: issue.identifier, reason: error.message });
          return;
        }
        const record = this.failures.get(issue.id) || { attempts: 0, retry_after: null, last_error: null };
        record.attempts += 1;
        record.last_error = error.message;
        record.retry_after = new Date(Date.now() + this.retryBackoff(record.attempts)).toISOString();
        this.failures.set(issue.id, record);
        this.dispatchHistory.push({ issue_id: issue.id, identifier: issue.identifier, finished_at: nowIso(), status: claim.status, error: error.message });
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
    const delay = 10000 * 2 ** Math.min(attempts - 1, 8);
    return Math.min(delay, this.config.agent.max_retry_backoff_ms);
  }

  // What the run changed inside the folder, so the blast radius is visible afterwards.
  async recordChanges(issue, baseline) {
    if (!baseline?.git) return;
    try {
      const changes = await changesSince(issue.workspace_path, baseline);
      if (!changes) return;
      this.lastChanges.set(issue.id, changes);
      this.logger.event("info", "workspace_changes", { issue_id: issue.id, identifier: issue.identifier, ...changes });
    } catch (error) {
      this.logger.event("warn", "workspace_diff_failed", { issue_id: issue.id, error: error.message });
    }
  }

  recordUsage(liveSession, claim) {
    if (!liveSession) return;
    this.codexTotals.input_tokens += Number(liveSession.codex_input_tokens || 0);
    this.codexTotals.output_tokens += Number(liveSession.codex_output_tokens || 0);
    this.codexTotals.total_tokens += Number(liveSession.codex_total_tokens || 0);
    this.codexTotals.turns += Number(liveSession.turn_count || 0);
    this.codexTotals.runs += 1;
    const started = Date.parse(claim.claimed_at);
    if (Number.isFinite(started)) this.codexTotals.runtime_seconds += Math.round((Date.now() - started) / 1000);
  }

  // Spec section 10: every tick, check what the tracker now says about running issues and
  // stop the ones that are no longer ours to run. Marking a claim was not enough -- the
  // agent process kept going after its card was moved out of the active states.
  async reconcile() {
    const runningIds = [...this.claims.keys()];
    if (!runningIds.length) return;

    let issues;
    try {
      issues = await this.tracker.fetchIssuesByIds(runningIds);
    } catch (error) {
      // A read failure is not evidence that the work should stop; try again next tick.
      this.logger.event("warn", "reconcile_fetch_failed", { error: error.message });
      return;
    }

    const terminal = new Set(this.config.tracker.terminal_states);
    const active = new Set(this.config.tracker.active_states);
    const seen = new Set();

    for (const issue of issues) {
      const claim = this.claims.get(issue.id);
      if (!claim) continue;
      seen.add(issue.id);
      const state = normalizeState(issue.state);

      if (terminal.has(state)) {
        await this.terminateRun(issue, claim, "terminal_state", true);
      } else if (!active.has(state)) {
        await this.terminateRun(issue, claim, "state_no_longer_active", false);
      } else if (!issue.dispatchable) {
        await this.terminateRun(issue, claim, "no_longer_dispatchable", false);
      } else {
        claim.issue = issue;
        claim.state = issue.state;
        claim.heartbeat_at = nowIso();
      }
    }

    for (const issueId of runningIds) {
      if (seen.has(issueId)) continue;
      const claim = this.claims.get(issueId);
      if (claim) await this.terminateRun(claim.issue, claim, "no_longer_visible", false);
    }
  }

  // A task is a folder, so the session running in that folder IS the task's state. The
  // board follows it: working while a turn is running, waiting when the session handed
  // control back with a question, idle when it is open but has nothing pending, and
  // ended once the process is gone.
  async watchExternalSessions() {
    const settings = this.config.sessions;
    if (!settings.watch) return;
    const managed = Object.values(settings.states).filter(Boolean);
    if (!managed.length) return;
    const managedKeys = new Set(managed.map(normalizeState));

    let sessions;
    let issues;
    try {
      sessions = await this.scanSessions(settings.names.length ? settings.names : undefined);
      issues = await this.tracker.readIssues();
    } catch (error) {
      this.logger.event("warn", "session_watch_failed", { error: error.message });
      return;
    }

    const stillWatched = new Set();
    for (const issue of issues) {
      if (!issue.workspace_path) continue;
      // Symphony's own runs have their own lifecycle; do not move them underneath it.
      if (this.claims.has(issue.id)) continue;
      // Only states the watcher owns. A card parked in Archive or Canceled stays put.
      if (!managedKeys.has(normalizeState(issue.state))) continue;

      const live = sessionsForPath(sessions, issue.workspace_path);
      const entry = this.externalWatch.get(issue.id) || { seen: false, empty: 0 };

      if (live.length) {
        stillWatched.add(issue.id);
        this.externalWatch.set(issue.id, { seen: true, empty: 0 });
        await this.applySessionState(issue, settings.states[phaseOf(live)], "session_phase");
        continue;
      }

      if (!entry.seen) continue;
      entry.empty += 1;
      stillWatched.add(issue.id);
      this.externalWatch.set(issue.id, entry);
      // One missing poll can be a CLI restart; only a settled absence means it ended.
      if (entry.empty < settings.settle_polls) continue;

      if (await this.applySessionState(issue, settings.states.ended, "session_ended")) {
        this.externalWatch.delete(issue.id);
        stillWatched.delete(issue.id);
      }
    }

    for (const issueId of [...this.externalWatch.keys()]) {
      if (!stillWatched.has(issueId)) this.externalWatch.delete(issueId);
    }
  }

  async applySessionState(issue, target, reason) {
    if (!target || normalizeState(issue.state) === normalizeState(target)) return true;
    try {
      const updated = await this.tracker.updateIssueState(issue.id, target);
      if (updated) {
        this.logger.event("info", "session_state_synced", {
          issue_id: issue.id,
          identifier: issue.identifier,
          from: issue.state,
          to: target,
          reason
        });
      }
      return true;
    } catch (error) {
      this.logger.event("warn", "session_state_sync_failed", { issue_id: issue.id, error: error.message });
      return false;
    }
  }

  async terminateRun(issue, claim, reason, cleanWorkspace) {
    if (claim.status === "Canceling") return;
    claim.status = "Canceling";
    this.logger.event("info", "run_canceled", {
      issue_id: issue.id,
      identifier: issue.identifier,
      state: issue.state,
      reason
    });
    this.runner.cancel(issue.id, reason);

    // Wait for the process to actually go before touching its workspace, but never let a
    // child that ignores SIGTERM stall the poll loop.
    await Promise.race([claim.promise?.catch(() => {}) ?? Promise.resolve(), sleep(5000)]);

    if (!cleanWorkspace || issue.workspace_path) return;
    try {
      await this.workspaceManager.remove(issue);
      this.logger.event("info", "workspace_removed", { issue_id: issue.id, identifier: issue.identifier });
    } catch (error) {
      this.logger.event("warn", "workspace_cleanup_failed", { issue_id: issue.id, error: error.message });
    }
  }

  // Spec section 11: workspaces left behind by issues that finished while the daemon was
  // down. Folders a task points at are the user's, so they are skipped.
  async cleanupTerminalWorkspaces() {
    try {
      const issues = await this.tracker.fetchTerminalIssues(this.config.tracker.terminal_states);
      let removed = 0;
      for (const issue of issues) {
        if (issue.workspace_path) continue;
        await this.workspaceManager.remove(issue);
        removed += 1;
      }
      if (removed) this.logger.event("info", "startup_workspaces_cleaned", { count: removed });
    } catch (error) {
      this.logger.event("warn", "startup_cleanup_failed", { error: error.message });
    }
  }

  async release(issueId) {
    const claim = this.claims.get(issueId);
    if (!claim) return false;
    this.claims.delete(issueId);
    this.logger.event("info", "claim_released", { issue_id: issueId });
    return true;
  }

  async forget(issueId) {
    await this.release(issueId);
    const hadFailure = this.failures.delete(issueId);
    if (hadFailure) this.logger.event("info", "failure_cleared", { issue_id: issueId });
    return hadFailure;
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
      session_watch: Object.fromEntries(this.externalWatch),
      codex_totals: { ...this.codexTotals },
      guard_refused: Object.fromEntries(this.guardRefused),
      last_changes: Object.fromEntries(this.lastChanges),
      dispatch_history: this.dispatchHistory.slice(-50)
    };
  }
}

function compareIssues(a, b) {
  const priorityA = a.priority == null ? Number.MAX_SAFE_INTEGER : a.priority;
  const priorityB = b.priority == null ? Number.MAX_SAFE_INTEGER : b.priority;
  return priorityA - priorityB || String(a.created_at || "").localeCompare(String(b.created_at || "")) || a.identifier.localeCompare(b.identifier);
}
