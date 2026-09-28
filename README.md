### The board follows your session

A task is a folder, so the session running in that folder is the task's state. The board
follows it rather than being kept in step by hand:

| What the session is doing | Column |
| --- | --- |
| A turn is running (`stop_reason: tool_use`) | In Progress |
| The turn ended with a question for you | Human Review |
| Open but with nothing pending | Ready |
| Process gone | Done |

```yaml
sessions:
  watch: true
  settle_polls: 2
  states:
    working: In Progress
    idle: Ready
    waiting: Human Review
    ended: Done
```

Claude records why each turn stopped, which is what separates working from handed-back.
Separating *waiting on an answer* from *idle* is the one judgement call: it reads the
last thing the assistant said and asks whether it ends in a question. That heuristic is
in `looksLikeAQuestion` and is the part most worth tuning.

A card is only moved out of the four states above, so anything parked in Archive or
Canceled stays put, and a task Symphony is running itself is left to its own lifecycle.
Reaching Done needs a session to have actually been seen in that folder first and then
be gone for `settle_polls` polls, so a restart does not sweep untouched cards into Done.
Set `watch: false` to turn all of it off.

### Archive on a timer

```yaml
archive:
  enabled: true
  from_state: Done
  to_state: Archive
  after_days: 2
```

A card that has sat in `from_state` untouched for `after_days` moves to `to_state` on the
next poll, so finished work leaves the Done column without anyone tidying it.

### Proof of work

The point of the board is to review finished work rather than supervise it being done,
and an agent's own account of itself is not evidence. So every run that finishes records
two things on the card: what it changed inside the folder, and whether the project's own
check still passes.

A task carries its own `verify_command`; `verify.command` in `WORKFLOW.md` is the
fallback for tasks that do not set one.

```yaml
verify:
  enabled: true
  command: null
  timeout_ms: 300000
```

The card shows one line — `8 files, +162/-9 · checks passed` — with the command, exit
code, duration and the tail of its output underneath. A failing check is recorded as
failed with its output kept, since that is the output most worth reading. A task with no
check command still records its diff and says plainly that no check was configured
rather than implying success.

The evidence lives on the issue in `last_run`, so it survives a restart, and
`GET /api/suggest-verify?path=<folder>` proposes a command from what the folder contains
(`package.json` to `npm test`, and so on) instead of guessing one and running it unasked.

This covers the review half of the pitch. Branch-per-task and pull requests do not
appear here on purpose: they are how a team hands work to reviewers, and they conflict
with pointing a task at the folder you are already working in.

### Being told instead of looking

A board that reports correctly still only reports to someone looking at it. With several
folders in flight the scarce thing is attention, so the machine says when it needs you.

```yaml
notify:
  enabled: true
  on: [human_review, check_failed]
  command: null
  after_waiting_ms: 60000
```

macOS notifications by default; set `command` to your own notifier and it receives
`SYMPHONY_NOTIFY_TITLE` and `SYMPHONY_NOTIFY_MESSAGE`. The same card does not nag on
every poll, and `after_waiting_ms` is the reason your own terminal stays quiet: answer a
question within that window and nothing is sent, because you were already there.

A browser popup is deliberately not the alerting mechanism — it only works while the
board is open, which is exactly when you do not need it.

### Answering a question from the board

A session that ends its turn with a question is waiting on a person, and the card shows
what it asked. When it is safe to do so, the card also takes the answer and sends it
back:

```yaml
reply:
  enabled: true
  timeout_ms: 900000
```

`POST /api/issues/<id>/reply` with `{"answer": "..."}` resumes that conversation by id —
`claude --resume <session>` or `codex exec resume <session>` — in the task's folder, and
records the result on the issue as `last_reply`.

Two things are worth knowing about how this works.

**It cannot type into your terminal.** Injecting keystrokes into another process's TTY is
blocked by the operating system, and rightly so. What it does instead is resume the same
conversation in a new process, which is a different thing.

**Which means it refuses while your terminal is open.** Resuming beside a live session
puts two processes on one conversation, and this project already hit that collision once.
So the card shows the question either way, but the answer box appears only when nothing is
running in that folder — otherwise it says to answer in the terminal. In practice the box
is for runs Symphony dispatched itself, which leave no terminal behind.

The answer is passed to the CLI as an argument rather than through a shell, so quotes,
backticks and semicolons in what you type stay text. There is a test that tries to make
an answer run a command and asserts it does not.

### One worker per folder

A folder holds one worker at a time (`agent.max_concurrent_agents_per_folder`), and
`dispatch_guard.skip_if_session_open` stops Symphony dispatching into a folder you
already have a session open in. Both prevent the same failure: two agents editing the
same files with no idea the other exists.

### Sessions that were only ever left open

A process can sit idle for days. Counting it as live makes the board claim work is
happening when a terminal was simply never closed, so a session quiet for longer than
`sessions.stale_after_hours` stops counting — it no longer holds a card in a state and no
longer blocks dispatch. The card still lists it with its idle time, so you can see what
is worth closing. Nothing is killed for you.

### The dispatch guard

Auto-dispatch lets an agent write with nobody watching, and a task's folder is a folder
you already work in. Before dispatching, the folder must be a git repository with at
least one commit; otherwise the run is refused and the reason is logged once:

```yaml
dispatch_guard:
  require_git: true
```

After a run finishes, what it changed inside the folder — commits, files, insertions,
deletions, whether the tree is dirty — is recorded on the state snapshot and in the log.

This is a safety net, not a fence. Nothing here stops an agent from writing outside the
task's folder; a real test run edited files two directories away. Confining it to one
folder needs the CLI's own permission configuration, which differs per CLI. What the
guard buys you is that whatever happens inside the folder can be seen and undone.

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
- An Archive drawer inside the Done column, so finished work collapses out of the way.
- Live running indicators for sessions Symphony dispatched *and* sessions you started yourself.
- The board follows your sessions: a card's column is decided by what its session is doing.
- Done ages into Archive on its own, and auto-dispatch is refused for folders with no undo.
- Proof of work: every finished run records what it changed and whether the project's checks pass.
- Desktop notifications when a session is waiting on you or a check fails.
- The question a session is waiting on, shown on its card and answerable from there.
- One worker per folder, and never one beside a session you already have open.
- Live session detail: each running session's topic and current activity, read from the CLI's own transcript.
- Spec section 10/11 reconciliation: a run whose card leaves the active states is actually terminated.

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

`Archive` is a terminal state, but it is not a column. Archived cards collapse into a
drawer at the top of the Done column; the Done cards that are not archived yet sit
directly below it. Any card in a terminal state gets a one-click `Archive` button, and
the drawer stays open or closed across refreshes.

## Operator API

The board's own endpoints (`/api/config`, `/api/issues`, `/api/state`, `/api/logs`) are
extensions: the spec's tracker contract is a read kernel and says nothing about creating
or editing tasks. Alongside them the server exposes the spec's operator surface:

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/state` | running claims, retries, `codex_totals`, live external sessions |
| `GET /api/v1/<identifier>` | one issue with its claim, failure, sessions and history |
| `POST /api/v1/refresh` | runs a poll and reconciliation immediately |

Every error is the spec envelope, `{"error":{"code":"...","message":"..."}}`.

A run attempt reports the spec's phases as it goes — `PreparingWorkspace`,
`BuildingPrompt`, `LaunchingAgentProcess`, `StreamingTurn`, `Finishing` — and ends on
`Succeeded`, `Failed`, `TimedOut`, `Stalled` or `CanceledByReconciliation`. Failure
backoff is the spec's `10000 * 2^(attempt-1)`, capped by `agent.max_retry_backoff_ms`.

## Reconciliation

Every tick, running issues are checked against the tracker. A card moved to a terminal
state terminates its agent process and clears its managed workspace; a card that stops
being dispatchable, leaves the active states, or disappears terminates without cleanup.
A cancelled run is recorded as `canceled`, not `failed`, so it earns no retry backoff.
A tracker read failure leaves running work alone and retries on the next tick.

Workspaces left behind by issues that finished while the daemon was down are removed at
startup. Folders a task points at with `workspace_path` are never cleaned: they are
yours.

## Seeing Sessions You Started Yourself

The board shows a green dot and a spinner for any task whose folder has an AI CLI
running in it, whether or not Symphony started it. Open a terminal, `cd` into a task's
folder and run `claude`, and that task lights up.

`src/sessions.js` asks the OS: `ps` for processes named `claude`, `codex`, `aider` or
`goose` (skipping `/Applications` bundles, so the Claude desktop app is not mistaken for
a CLI), then one `lsof` call for their working directories. A session counts for a task
when it runs in the task's folder or below it. Results are cached for two seconds.

This is how the board stays honest about what is happening: a folder is busy because
something is running in it, not because Symphony is the one that ran it.

Each session also carries what it is doing, read from the CLI's own transcript
(`~/.claude/projects/<folder>/*.jsonl`, `~/.codex/sessions/**/rollout-*.jsonl`): the
session's topic, its latest message or tool call, and how long ago that was. Only the
tail of each file is read, and nothing is written back or stored. The board renders this
on the card, so conversation text appears in the UI -- the server binds `127.0.0.1` only.

### When your session ends

`sessions` in `WORKFLOW.md` moves a task on once the session you were running in its
folder goes away:

```yaml
sessions:
  watch: true
  from_states: [In Progress]
  to_state: Human Review
  settle_polls: 2
```

A task is moved only if a session was actually seen there first, only from
`from_states`, and only after `settle_polls` consecutive polls with nothing running, so
a CLI restart does not trip it. Tasks Symphony itself is running are left to their own
lifecycle. Set `watch: false` to turn it off.

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

## Where This Differs From the Spec

This is an independent implementation of `SPEC.md`, not a port of the Elixir reference.
Three departures are deliberate and worth knowing:

- **No `codex app-server` protocol.** The spec targets a session protocol with thread and
  turn ids, token accounting and tool advertisement. This runs `bash -lc <command>` and
  reads the agent's stdout instead. That is what makes per-task agent routing possible —
  the spec has a single `codex.command` — but it means the live-session fields are filled
  from whatever a CLI prints rather than from a protocol.
- **`workspace_path` escapes the workspace root.** The spec makes workspace isolation
  mandatory. Pointing a task at a folder you already work in breaks that on purpose, which
  is why `remove()` refuses those folders and the demo hooks that wrote into the working
  directory were deleted. Keep those folders under version control.
- **Writes to the tracker.** The spec's adapter is a read kernel; board CRUD is an
  extension of it.

Still missing: the spec's continuation retry (a fixed 1000 ms re-queue after a normal
exit) and `codex_rate_limits`, which has no source without the app-server protocol.

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
