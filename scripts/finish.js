#!/usr/bin/env node

// Moves the task this agent ran for into a new state, so the orchestrator stops
// dispatching it. A real CLI (claude, codex) does not update the tracker itself the
// way scripts/mock-agent.js does, so its agent command ends by calling this.
//
//   node "$SYMPHONY_HOME/scripts/finish.js" "Human Review"

import { LocalJsonTracker } from "../src/tracker.js";

const state = process.argv[2] || "Human Review";
const trackerPath = process.env.SYMPHONY_TRACKER_PATH;
const issueId = process.env.SYMPHONY_ISSUE_ID;

if (!trackerPath || !issueId) {
  emit("finish_skipped", "SYMPHONY_TRACKER_PATH or SYMPHONY_ISSUE_ID is not set");
  process.exit(0);
}

try {
  // Clearing dispatchable is what actually stops the loop: the review states are still
  // active states, so a task left dispatchable would be picked up again on the next poll.
  const updated = await new LocalJsonTracker(trackerPath).updateIssue(issueId, { state, dispatchable: false });
  if (updated) emit("tracker_updated", `moved ${updated.identifier} to ${state} and cleared auto-dispatch`);
  else emit("finish_skipped", `issue ${issueId} is no longer in the tracker`);
} catch (error) {
  emit("finish_failed", error.message);
  process.exit(1);
}

function emit(event, message) {
  console.log(JSON.stringify({
    type: "codex_event",
    event,
    issue: process.env.SYMPHONY_ISSUE_IDENTIFIER || issueId,
    turn: process.env.SYMPHONY_TURN || "1",
    message
  }));
}
