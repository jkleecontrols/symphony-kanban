# Symphony Local

Local implementation of the OpenAI Symphony service specification.

It includes:

- `WORKFLOW.md` loader with front matter, config defaults, validation, dynamic reload, and strict prompt rendering.
- Local JSON issue tracker adapter using the normalized issue model.
- Orchestrator with polling, active/terminal states, required labels, bounded concurrency, per-state concurrency, claims, retries, continuation, and reconciliation.
- Workspace manager with deterministic sanitized workspace keys, lifecycle hooks, cleanup, and path safety.
- Agent runner that executes a configured shell command inside each issue workspace and streams structured events.
- Structured JSONL logs and an operator HTTP surface with Kanban, runtime state, issues, logs, and API actions.

This implementation uses a `local_json` tracker so you can run Symphony without external credentials. New tracker providers can be added behind the adapter interface in `src/tracker.js`.

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
