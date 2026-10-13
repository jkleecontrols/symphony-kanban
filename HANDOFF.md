# Handoff

Where the board stands and what is open, for a session picking this up fresh.

`README.md` describes everything that exists and why. This file is only the open edges.

## State

Running as a launchd agent (`com.jkleecontrols.symphony-kanban`) on
http://127.0.0.1:8787, restarting itself at login and on crash. No dependencies.
`data/issues.json` holds the real task list and is not tracked.

Nine cards: the research repositories, the personal site, this board, and a worktree
`ofpp-explore-a` sharing the thread `occlusion exposure model` with the main ofpp card.

An Obsidian vault at `~/Documents/Obsidian Vault` has every project's markdown symlinked
under `Projects/`, and finished runs append a line to each project's note.

## Latest (2026-10-13)

The owner writes in Korean; reply in Korean and keep it short. Ask before any `git push`.

The Claude per-turn usage fix was committed as `401edc8`. It replaced the old
session-start-date accounting, which showed $0.03 on a roughly $22 day. The estimate
was about 6% below Claude Code's own figure in one cross-check. Codex's gauge was already
working; its session file had simply been old.

The owner chose hand-drawn arrows to mean dependencies: A → B writes A into B's
`blocked_by`. The graph view now draws project → thread → card, allows arrow drag and
removal, and lets cards be dropped on threads. The server accepts dependency patches and
rejects self-links, unknown cards and cycles. Browser drag and arrow removal were checked
on the live board; the temporary dependency was removed. The service was restarted to
load the new API. This graph work is committed as `845814b`. See README.md for use.

The board now keeps four columns: Ready, In Progress, Human Review, Archive. Session ends
land in Archive; after two quiet days they move to a collapsed Done drawer. Canceled is a
second drawer there. The existing local Done and Archive states were exchanged so the
same cards stay visible or hidden as before.

Further changes to `src/usage.js`, `src/transcripts.js`, `scripts/claude-limits.js`,
`WORKFLOW.md`, `.gitignore`, and the usage and transcript tests:

- **The Claude gauge now shows the plan's real limits**, the same session and weekly
  percentages as Claude's own usage screen, instead of dollars against a declared budget.
  Claude Code gives those numbers only to its status line, so `statusLine` in
  `~/.claude/settings.json` runs `scripts/claude-limits.js`, which saves them to
  `data/claude-limits.json` (untracked). They refresh only while a Claude session is open.
  The per-turn dollar estimate from `401edc8` is now the fallback when that file is absent,
  and the $200/$600 budget was removed from `WORKFLOW.md`.
- **A Codex session in a folder now moves that folder's card.** Codex's log opens with a
  record of about 20 KB and the board read only the first 8 KB, so it never learned which
  folder a Codex session belonged to. A long turn was also read as idle, because its start
  marker had scrolled out of the part of the log the board reads.

## Open

- **Auto-dispatch is off everywhere.** It works, and a real run was verified end to end,
  but an agent is not confined to the task's folder — one test run edited files two
  directories away. Turn it on per card, on something that does not matter, watching.
- **OmniRoute usage is absent** from the gauges. `usage quota` answers for three providers
  but every field reads null because no request has gone through it. Add the collector when
  it is actually in use; it is about twenty lines.
- **Parallel work, phase 2 and 3**: creating worktrees from the board, per-role prompt
  templates in `WORKFLOW.md`, and a supervising session reading `/api/v1/state`. Phase 3
  already works without any code — tell a session to read that endpoint.
- **Starting a fresh session automatically** to keep cost down. The owner asked for it;
  nothing is built.

## Things learned the hard way

- `normalizeIssue` is a fixed field list. A field added elsewhere and forgotten there is
  dropped on every read with no error. It happened three times. `test/tracker.test.js`
  now round-trips every field.
- The board is one script with no build step, so a function that is called but never
  defined only shows as a blank page. Happened twice. `test/board.test.js` catches it.
- Verify in the browser, not just the API. Both of those were found by loading the page.
