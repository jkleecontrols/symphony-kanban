# Handoff

Where the board stands and what is open, for a session picking this up fresh.

`README.md` describes everything that exists and why. This file is only the open edges.

## State

Running as a launchd agent (`com.jkleecontrols.symphony-kanban`) on
http://127.0.0.1:8787, restarting itself at login and on crash. 76 tests, no dependencies.
`data/issues.json` holds the real task list and is not tracked.

Nine cards: the research repositories, the personal site, this board, and a worktree
`ofpp-explore-a` sharing the thread `occlusion exposure model` with the main ofpp card.

An Obsidian vault at `~/Documents/Obsidian Vault` has every project's markdown symlinked
under `Projects/`, and finished runs append a line to each project's note.

## Open

- **Auto-dispatch is off everywhere.** It works, and a real run was verified end to end,
  but an agent is not confined to the task's folder — one test run edited files two
  directories away. Turn it on per card, on something that does not matter, watching.
- **OmniRoute usage is absent** from the gauges. `usage quota` answers for three providers
  but every field reads null because no request has gone through it. Add the collector when
  it is actually in use; it is about twenty lines.
- **`blocked_by` has no form field.** It works and is tested, but setting it needs a PATCH
  by hand. A dependency picker on the card is the obvious next thing.
- **Parallel work, phase 2 and 3**: creating worktrees from the board, per-role prompt
  templates in `WORKFLOW.md`, and a supervising session reading `/api/v1/state`. Phase 3
  already works without any code — tell a session to read that endpoint.
- **The node graph** from the dashboard that inspired the activity feed is deliberately
  absent. It earns its keep when one thread spawns many agents; revisit at that depth.

## Things learned the hard way

- `normalizeIssue` is a fixed field list. A field added elsewhere and forgotten there is
  dropped on every read with no error. It happened three times. `test/tracker.test.js`
  now round-trips every field.
- The board is one script with no build step, so a function that is called but never
  defined only shows as a blank page. Happened twice. `test/board.test.js` catches it.
- Verify in the browser, not just the API. Both of those were found by loading the page.
