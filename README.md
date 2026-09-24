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
- Per-task project folder: a task can run in a folder you already work in, instead of a generated workspace.
- Three themes (Apple, Pink, Blue), switchable from the board.
- An Archive column and a one-click Archive button, so finished work leaves the Done column.
- Live running indicators: a spinner and a pulsing dot on every card with an active session.

This implementation uses a `local_json` tracker so you can run Symphony without external credentials. New tracker providers can be added behind the adapter interface in `src/tracker.js`.

## Setup

`data/issues.json` holds your real task list and is not tracked by git. Create it
from the example before the first run:

```sh
cp data/issues.example.json data/issues.json
npm start
```

## One Task Per Project Folder

A task's `workspace_path` names a folder you already work in. The agent for that task
runs with that folder as its working directory, so whichever AI picks the task up is
looking at the same files and updating the same notes.

```json
{
  "title": "my-paper",
  "workspace_path": "~/research/my-paper",
  "agent": "omniroute"
}
```

`~` and `$VARS` are expanded, and a relative path resolves against the project root.
The folder must already exist: the API returns 400 rather than creating one, so a typo
does not scatter empty directories.

A folder named this way belongs to you, not to Symphony. It is never created, never
seeded by the `after_create` hook, and `WorkspaceManager.remove()` refuses to delete it.
A task with no `workspace_path` still gets a managed workspace under `workspace.root`
and behaves exactly as before.

Keep `before_run` and `after_run` unset unless you want files written into the folders
your tasks point at. Both hooks run in the task's folder, whichever folder that is.

## Wiring Up a Real Agent

`claude` and `codex` resume the folder's own conversation, matching what you would do by
hand: `cd` into the folder and continue where you left off.

```sh
claude --continue --print "$SYMPHONY_PROMPT"   # falls back to a fresh session
codex exec resume --last "$SYMPHONY_PROMPT"    # falls back to codex exec
```

Two things every real agent command needs:

**End by calling `scripts/finish.js`.** The orchestrator dispatches any task that is
active and dispatchable. `scripts/mock-agent.js` sets its own state to `Done`, so it
stops; a real CLI does not, and the task would be dispatched again on every poll. Ending
the command with `node "$SYMPHONY_HOME/scripts/finish.js" "Human Review"` moves the task
out of the active states and stops the loop. `SYMPHONY_HOME` is the directory holding
`WORKFLOW.md`, so this works from any folder.

**Check permissions before trusting it unattended.** `claude --print` and `codex exec`
run with no one at the keyboard. Whether they can edit files without a prompt depends on
your own CLI configuration. Run one task manually and watch what happens before turning
auto-dispatch on for a folder that matters. This project deliberately ships no
permission-skipping flags.

`claude-omni` routes Claude Code through OmniRoute, which is a router rather than an
agent of its own: it points an existing CLI at different models with fallback. That entry
is untested here and needs one real run before you rely on it.

## Archive

`Archive` is a terminal state sitting between `Done` and `Canceled`. Cards in any
terminal state get a one-click `Archive` button. Every column is capped at 62% of the
viewport height and scrolls internally, so a long column never stretches the page.

## Themes

The board ships three themes — Apple (clean, default), Pink and Blue — switchable from
the top bar and remembered per browser. Each is a block of custom properties at the top
of `public/styles.css`; add a fourth by copying one and adding its name to `THEMES` in
`public/app.js`.

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

The agent's working directory is the task's `workspace_path` when it has one, and a
managed workspace otherwise.

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
