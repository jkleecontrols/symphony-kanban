# Symphony Local

Local implementation of the OpenAI Symphony service specification.

It includes:

- `WORKFLOW.md` loader with front matter, config defaults, validation, dynamic reload, and strict prompt rendering.
- Local JSON issue tracker adapter using the normalized issue model.
- Orchestrator with polling, active/terminal states, required labels, bounded concurrency, per-state concurrency, claims, retries, continuation, and reconciliation.
- Workspace manager with deterministic sanitized workspace keys, lifecycle hooks, cleanup, and path safety.
- Agent runner that executes a configured shell command inside each issue workspace and streams structured events.
- Structured JSONL logs and an operator HTTP surface with Kanban, runtime state, issues, logs, and API actions.
- Task CRUD from the board itself: add, edit, and delete tasks without hand-editing JSON.
- Per-task agent routing: each task picks which configured AI runs it.

This implementation uses a `local_json` tracker so you can run Symphony without external credentials. New tracker providers can be added behind the adapter interface in `src/tracker.js`.

## Managing Tasks From the Board

The board is the primary way to manage work. `+ New Task` opens a form for title,
description, priority, state, labels, assigned AI, and auto-dispatch. Each card has
`Edit` for inline editing and a two-step `Delete`. Required labels from
`tracker.required_labels` are added automatically, so a task created on the board is
always eligible for dispatch.

Board edits go through the HTTP API, which is also usable directly:

```sh
curl localhost:8787/api/config                      # states, agents, required labels
curl -X POST localhost:8787/api/issues -H 'content-type: application/json' \
  -d '{"title":"Write release notes","state":"Ready","agent":"mock"}'
curl -X PATCH localhost:8787/api/issues/local-4 -H 'content-type: application/json' \
  -d '{"agent":"omniroute","priority":1}'
curl -X DELETE localhost:8787/api/issues/local-4
```

While a card is open for editing, the board pauses its 3-second auto-refresh so
in-progress input is never overwritten.

## Running Several AIs

`agents` in `WORKFLOW.md` maps a name to the shell command that runs that agent:

```yaml
agents:
  omniroute:
    label: OmniRoute
    command: |
      omniroute run --prompt "$SYMPHONY_PROMPT"
agent:
  default_agent: omniroute
```

Write every command as a `|` block. The front-matter parser strips a trailing quote
from an inline scalar, which would corrupt a command ending in `"`.

A task runs the agent named in its `agent` field; a task with no agent falls back to
`agent.default_agent`. An unknown name is logged as `agent_not_found` and also falls
back, so a typo never silently skips the work. Each turn's child process receives:

| Variable | Contents |
| --- | --- |
| `SYMPHONY_PROMPT` | rendered prompt template |
| `SYMPHONY_AGENT` | resolved agent name |
| `SYMPHONY_ISSUE_ID` / `_IDENTIFIER` | tracker ids |
| `SYMPHONY_ISSUE_TITLE` / `_STATE` / `_LABELS` | issue fields, labels comma-separated |
| `SYMPHONY_ATTEMPT` / `_TURN` | retry and turn counters |
| `SYMPHONY_TRACKER_KIND` / `_PATH` | tracker location, for writing results back |

An agent reports progress by printing one JSON object per line to stdout and marks
work finished by updating the tracker itself. `scripts/mock-agent.js` is the reference
implementation of both halves.

Agents shipped as `NOT CONFIGURED YET` print an `agent_not_configured` event and exit
non-zero, so an unconfigured agent fails loudly instead of appearing to do nothing.

## Known Limits

- Deleting a task frees its id, so the next task created can reuse that id, and with it
  the `data/workspaces/<IDENTIFIER>` directory of the deleted task.
- The API has no authentication or CSRF protection. It binds `127.0.0.1` only and
  assumes a single trusted local operator.
- The server stops when its terminal closes; there is no supervisor yet.

## Run

```sh
npm start
```

Open <http://127.0.0.1:8787>.

The included `WORKFLOW.md` points at `data/issues.json`, uses `data/workspaces`, and runs `node ../../scripts/mock-agent.js` as the demo agent.

## Useful Commands

```sh
node src/cli.js start --workflow WORKFLOW.md --port 8787
node src/cli.js validate --workflow WORKFLOW.md
node src/cli.js once --workflow WORKFLOW.md
npm test
```

## Trust and Safety Posture

This local implementation is intended for trusted personal workspaces. It enforces the spec's mandatory filesystem safety requirements: issue workspaces stay under the configured workspace root, workspace names are sanitized, hooks and agents run with the per-issue workspace as cwd, hook timeouts are enforced, and tracker secret environment variables declared by adapters are removed from the agent child environment.

`WORKFLOW.md` hooks and the configured agent command are trusted local code. Use restrictive Codex approval/sandbox settings and narrow tracker scopes before connecting this to real project credentials.
