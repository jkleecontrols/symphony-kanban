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
  after_create: |
    printf "workspace ready\n" > .symphony_workspace
  before_run: |
    printf "attempt started at %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .symphony_attempts
  after_run: |
    printf "attempt finished at %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .symphony_attempts
agent:
  max_concurrent_agents: 2
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
