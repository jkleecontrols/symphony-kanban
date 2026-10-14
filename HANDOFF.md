# Handoff

Where the board stands and what is open, for a session picking this up fresh.

`README.md` describes everything that exists and why. This file is only the open edges.

The owner writes in Korean; reply in Korean and keep it short. Push completed work often.

## State

Running as a launchd agent (`com.jkleecontrols.symphony-kanban`) on
http://127.0.0.1:8787, restarting itself at login and on crash. 92 tests, no dependencies.
`data/issues.json` holds the real task list and is not tracked.

Twelve cards. The live ones are this board (`symphony-kanban`), its marketing worktree,
and two worktrees of `dissertation_Ofpp` in the thread `earth simulation`: `ofpp-earth-sim`
plans and `ofpp-earth-sim-impl` implements, joined by an arrow. Finished papers and the
prelim are put away in Done.

An Obsidian vault at `~/Documents/Obsidian Vault` has every project's markdown symlinked
under `Projects/`, and finished runs append a line to each project's note.

## What changed on 2026-10-13

All of it is committed and pushed to `origin/main`, up to `20271c4`, except where noted.

**Usage gauges.** The Claude gauge shows the plan's real limits, the same session and
weekly percentages as Claude's own usage screen. Claude Code gives those numbers only to
its status line, so `statusLine` in `~/.claude/settings.json` runs
`scripts/claude-limits.js`, which saves them to `data/claude-limits.json` (untracked).
They refresh only while a Claude session is open. Without that file the gauge falls back
to a dollar estimate priced from each turn's token counts.

**Codex sessions move cards.** Codex's log opens with a record of about 20 KB and the
board read only the first 8 KB, so it never learned which folder a Codex session was in.
Card and graph labels follow whichever CLI is live in the folder.

**Columns.** Ready, In Progress, Human Review, Archive. A session ending lands its card in
Archive; after two quiet days it moves to a collapsed Done drawer. A session starting in a
Done folder brings the card back.

**Graph view** (`public/graph.js`). Project → thread → card, drawn from the cards' own
fields.
- Drag the dot on a card to another card for an arrow. A → B writes A into B's
  `blocked_by`; the server rejects self-links, unknown cards and cycles.
- Drag a card onto a thread to move it there.
- Each card's role is a menu on the card, on the graph and on the board. The usual roles
  are listed in `ROLES` in `public/app.js`; one typed into a card's edit form joins the
  menu.
- Cards in a thread are ordered with what they depend on first.
- A Done graveyard sits in the corner of the window. Drag a card or a whole project onto
  it to put it away; Done cards are not drawn. Open it to bring one back.

**Motion and materials** (the last section of `public/styles.css`), after the
`apple-design` skill at github.com/emilkowalski/skills. Buttons answer on the press. A
dragged graph card follows the pointer and springs home at its release speed
(`springHome` in `public/graph.js`). Panels grow out of the top bar, which is translucent
and sticky. A theme change cross-fades. Reduced motion, reduced transparency and higher
contrast each have their own rules.

**Marketing worktree.** `~/symphony-kanban-marketing`, branch `marketing`, card KAN-13
with the role `marketing`, linked from this board's card. `AGENTS.md` there is the agent's
brief: it drafts under `marketing/`, publishes nothing itself, and claims only what the
README supports. `.agents/product-marketing.md` is a first positioning draft with five
open questions for the owner at the top. Five skills from
github.com/coreyhaines31/marketingskills (MIT) are installed in its `.claude/skills/` and
kept out of git by `.git/info/exclude`. The branch has one commit, `f2667a7`, **not
pushed**. To use it: start a session in that folder and ask it to begin.

## Open

- **`scripts/vault-sync.js` has an uncommitted change** left by a Codex session. Nobody in
  the later sessions wrote it or reviewed it. Read the diff before committing or
  discarding it.
- **The spring-back was never watched at full speed.** The test browser tab was hidden and
  got almost no animation frames. The same arithmetic, run separately, settles in 0.45 s
  without bounce. If it feels wrong, response and damping are the two numbers at the top
  of `springHome`.
- **README is behind the product.** Its screenshots show five columns and no graph, and it
  does not describe role menus, the graveyard or the plan-limit gauge. The marketing agent
  has this on its list too.
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
- A `const` declared below the board's first render is the same blank page: the script
  awaits `refresh()` at the top level, before later declarations exist. It happened with
  the role list. Put new top-level constants with the others at the top of `app.js`.
- Verify in the browser, not just the API. All three of those were found by loading the
  page.
- Two sessions can be in this folder at once, and were: Claude and Codex edited it
  together for an hour. Check `git status` and `git log` before assuming the tree is as
  you left it, and commit only the files you changed.
