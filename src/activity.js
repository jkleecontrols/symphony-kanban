import { sessionsForPath } from "./sessions.js";

// What has been happening, newest first, across every project. The board answers "where
// does this card stand"; this answers "what just happened", which is the question you
// have after being away from it.

// Log events worth surfacing, and how to say them.
const EVENTS = {
  issue_completed: { kind: "run", say: () => "run finished" },
  issue_failed: { kind: "run", attention: true, say: (e) => `run failed — ${clip(e.error)}` },
  issue_canceled: { kind: "run", say: () => "run cancelled" },
  verification_finished: { kind: "check", attention: (e) => !e.ok, say: (e) => (e.ok ? "checks passed" : `checks failed (exit ${e.exit_code})`) },
  command_run: { kind: "command", attention: (e) => !e.ok, say: (e) => `${e.label} → exit ${e.exit_code}` },
  session_state_synced: { kind: "state", say: (e) => `${e.from} → ${e.to}` },
  folder_discovered: { kind: "discovery", say: (e) => `found a session in ${short(e.path)}` },
  auto_archived: { kind: "state", say: (e) => `archived after ${e.idle_days}d idle` },
  dispatch_refused: { kind: "guard", attention: true, say: (e) => `dispatch refused — ${clip(e.reason)}` },
  dispatch_blocked: { kind: "guard", say: (e) => `waiting on ${e.blocked_by}` },
  run_canceled: { kind: "run", say: (e) => `run stopped — ${e.reason}` },
  notified: { kind: "alert", attention: true, say: (e) => clip(e.title) }
};

export async function buildActivity(orchestrator, { limit = 60, scanSessions } = {}) {
  const issues = await orchestrator.tracker.readIssues();
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const entries = [];

  // Anything running right now sits at the top, whoever started it.
  const settings = orchestrator.config.sessions;
  const scan = scanSessions || orchestrator.scanSessions;
  const sessions = await scan(settings.names.length ? settings.names : undefined).catch(() => []);

  for (const issue of issues) {
    for (const session of sessionsForPath(sessions, issue.workspace_path)) {
      entries.push({
        at: session.at || new Date().toISOString(),
        kind: "session",
        live: true,
        attention: session.phase === "waiting",
        issue: label(issue),
        headline: session.title || `${session.name} session`,
        detail: session.activity || session.phase || "running",
        agent: session.name
      });
    }
  }

  // Then what the log says happened, newest first.
  for (const event of [...orchestrator.logger.recent].reverse()) {
    const spec = EVENTS[event.event];
    if (!spec) continue;
    const issue = event.issue_id ? byId.get(event.issue_id) : null;
    entries.push({
      at: event.ts,
      kind: spec.kind,
      live: false,
      attention: typeof spec.attention === "function" ? Boolean(spec.attention(event)) : Boolean(spec.attention),
      issue: issue ? label(issue) : { identifier: event.identifier || null, title: null, project: null, thread: null },
      headline: spec.say(event),
      detail: null,
      agent: event.agent || null
    });
    if (entries.length > limit * 3) break;
  }

  entries.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return String(b.at).localeCompare(String(a.at));
  });

  return {
    at: new Date().toISOString(),
    counts: {
      live: entries.filter((e) => e.live).length,
      attention: entries.filter((e) => e.attention).length,
      total: entries.length
    },
    entries: entries.slice(0, limit)
  };
}

function label(issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    project: issue.project ? short(issue.project) : null,
    thread: issue.thread || null,
    role: issue.role || null,
    state: issue.state
  };
}

function short(value) {
  return String(value || "").replace(/^\/Users\/[^/]+/, "~");
}

function clip(text, max = 90) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
