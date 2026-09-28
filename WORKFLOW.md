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
verify:
  # After an agent run, run the task's own check and attach the result to the card.
  # A task sets its own `verify_command`; this is the fallback for tasks that do not.
  enabled: true
  command: null
  timeout_ms: 300000
dispatch_guard:
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
