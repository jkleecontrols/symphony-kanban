---
tracker:
  kind: local_json
  provider:
    path: data/issues.json
  required_labels:
    - symphony
  active_states:
    - Ready
    - In Progress
    - Human Review
  terminal_states:
    - Done
    - Archive
    - Canceled
polling:
  interval_ms: 5000
workspace:
  root: data/workspaces
hooks:
  timeout_ms: 10000
  # after_create runs only for managed workspaces under workspace.root, never for a
  # task that names its own workspace_path.
  after_create: |
    printf "workspace ready\n" > .symphony_workspace
  # before_run and after_run run in the task's folder, whichever folder that is. Leave
  # them unset unless you want files written into the folders your tasks point at.
sessions:
  # A task is a folder, so the session running in that folder is the task's state.
  # The board follows the session rather than being kept in step by hand.
  watch: true
  names:
    - claude
    - codex
    - aider
    - goose
  settle_polls: 2
  # A terminal left open for days is not work in progress.
  stale_after_hours: 12
  # A card parked in Archive whose folder starts working again comes back.
  revive_from_terminal: true
  # A session in a folder with no card gets one. Limit where that can happen.
  autodiscover: true
  autodiscover_roots:
    - ~/research
    - ~/symphony-kanban
    - ~/jkleecontrols.github.io
  states:
    working: In Progress
    idle: Ready
    waiting: Human Review
    ended: Done
archive:
  # Finished work leaves the Done column on its own after this many days untouched.
  enabled: true
  from_state: Done
  to_state: Archive
  after_days: 2
notify:
  # The board is passive; with several folders in flight the scarce thing is attention.
  # Leave `command` null to use macOS notifications, or set it to your own notifier
  # (it receives SYMPHONY_NOTIFY_TITLE and SYMPHONY_NOTIFY_MESSAGE).
  enabled: true
  on:
    - human_review
    - check_failed
  command: null
  # Answer within this window and no notification is sent; you were already there.
  after_waiting_ms: 60000
commands:
  # Buttons on every card. A task can add its own under its `commands` field; the board
  # can only trigger what is registered here or there, never free text from the browser.
  enabled: true
  timeout_ms: 600000
  shared:
    git status: git status --short --branch
    git diff: git diff --stat
terminal:
  # Opens the task's folder. If a session is already running there, its window is raised
  # instead of a second one being opened beside it.
  enabled: true
  app: iTerm
reply:
  # Answering from the board resumes the session by id in a new process. The board
  # refuses to send while a session is still open in that folder.
  enabled: true
  timeout_ms: 900000
usage:
  # Codex reports real rate limits. Claude Code records what a session cost but not your
  # plan's ceiling, so declare a budget to get a gauge for it.
  enabled: true
  budgets:
    claude:
      weekly_usd: 200
      monthly_usd: 600
verify:
  # After an agent run, run the task's own check and attach the result to the card.
  # A task sets its own `verify_command`; this is the fallback for tasks that do not.
  enabled: true
  command: null
  timeout_ms: 300000
dispatch_guard:
  # Never dispatch into a folder you already have a session open in.
  skip_if_session_open: true
  # Auto-dispatch writes with nobody watching. Refuse it unless the folder is a git
  # repository with at least one commit, so whatever happens can be seen and undone.
  require_git: true
agents:
  mock:
    label: Mock demo agent
    description: Fake agent. Proves the board and orchestrator work. Does no real work.
    command: |
      node "$SYMPHONY_HOME/scripts/mock-agent.js"
  claude:
    label: Claude Code
    description: Continues the folder's most recent Claude conversation, like claude --continue.
    command: |
      set -e
      # Claude Code replaces every character outside [A-Za-z0-9-] with a dash, not just slashes.
      proj="$HOME/.claude/projects/$(printf '%s' "$PWD" | sed 's|[^A-Za-z0-9-]|-|g')"
      if [ -d "$proj" ]; then
        claude --continue --print "$SYMPHONY_PROMPT"
      else
        claude --print "$SYMPHONY_PROMPT"
      fi
      node "$SYMPHONY_HOME/scripts/finish.js" "Human Review"
  codex:
    label: Codex CLI
    description: Resumes the folder's most recent Codex session, falling back to a new one.
    command: |
      set -e
      codex exec resume --last "$SYMPHONY_PROMPT" || codex exec "$SYMPHONY_PROMPT"
      node "$SYMPHONY_HOME/scripts/finish.js" "Human Review"
  claude-omni:
    label: Claude via OmniRoute
    description: NEEDS ONE TEST RUN. Routes Claude Code through OmniRoute for fallback and cheaper models.
    command: |
      set -e
      omniroute run claude --continue --print "$SYMPHONY_PROMPT"
      node "$SYMPHONY_HOME/scripts/finish.js" "Human Review"
agent:
  max_concurrent_agents: 2
  max_concurrent_agents_per_folder: 1
  default_agent: mock
  max_turns: 3
  max_retry_backoff_ms: 30000
  max_concurrent_agents_by_state:
    Ready: 2
    In Progress: 1
codex:
  command: node "$SYMPHONY_HOME/scripts/mock-agent.js"
  # A real CLI thinks for minutes and prints its answer at the end, so the mock's
  # 30s/15s demo values would kill every run before it said anything.
  turn_timeout_ms: 900000
  read_timeout_ms: 5000
  stall_timeout_ms: 600000
---
You are working on {{ issue.identifier }}: {{ issue.title }}.

State: {{ issue.state }}
Labels: {{ issue.labels }}
Attempt: {{ attempt }}

Use the repository workflow, make progress, and leave proof of work in the tracker.
