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
      node ../../../scripts/mock-agent.js
  claude:
    label: Claude Code
    description: NOT CONFIGURED YET. Replace command with your real claude invocation.
    command: |
      printf '{"type":"codex_event","event":"agent_not_configured","message":"agent claude has no real command yet - edit agents.claude.command in WORKFLOW.md"}\n'
      exit 1
  codex:
    label: Codex CLI
    description: NOT CONFIGURED YET. Replace command with your real codex invocation.
    command: |
      printf '{"type":"codex_event","event":"agent_not_configured","message":"agent codex has no real command yet - edit agents.codex.command in WORKFLOW.md"}\n'
      exit 1
  omniroute:
    label: OmniRoute
    description: NOT CONFIGURED YET. For simple tasks. Replace command with your real omniroute invocation.
    command: |
      printf '{"type":"codex_event","event":"agent_not_configured","message":"agent omniroute has no real command yet - edit agents.omniroute.command in WORKFLOW.md"}\n'
      exit 1
agent:
  max_concurrent_agents: 2
  default_agent: mock
  max_turns: 3
  max_retry_backoff_ms: 30000
  max_concurrent_agents_by_state:
    Ready: 2
    In Progress: 1
codex:
  command: node ../../../scripts/mock-agent.js
  turn_timeout_ms: 30000
  read_timeout_ms: 5000
  stall_timeout_ms: 15000
---
You are working on {{ issue.identifier }}: {{ issue.title }}.

State: {{ issue.state }}
Labels: {{ issue.labels }}
Attempt: {{ attempt }}

Use the repository workflow, make progress, and leave proof of work in the tracker.
