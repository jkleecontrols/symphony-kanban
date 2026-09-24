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
      proj="$HOME/.claude/projects/$(printf '%s' "$PWD" | sed 's|/|-|g')"
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
  turn_timeout_ms: 30000
  read_timeout_ms: 5000
  stall_timeout_ms: 15000
---
You are working on {{ issue.identifier }}: {{ issue.title }}.

State: {{ issue.state }}
Labels: {{ issue.labels }}
Attempt: {{ attempt }}

Use the repository workflow, make progress, and leave proof of work in the tracker.
