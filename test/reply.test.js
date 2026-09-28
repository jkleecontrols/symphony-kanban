import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canReplyTo, sendReply, supportedAgents } from "../src/reply.js";

test("the CLIs that can be resumed are the ones with a resume command", () => {
  assert.deepEqual(supportedAgents().sort(), ["claude", "codex"]);
  assert.equal(canReplyTo("claude"), true);
  assert.equal(canReplyTo("mock"), false, "a shell script has no conversation to resume");
});

test("an unknown agent is reported rather than launched", async () => {
  const result = await sendReply({ agent: "nope", sessionId: "x", cwd: os.tmpdir(), answer: "hi", timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /no resume command known/);
});

test("a missing CLI is reported rather than thrown", async () => {
  const result = await sendReply({
    agent: "claude", sessionId: "x", cwd: os.tmpdir(), answer: "hi", timeoutMs: 2000
  });
  // Either claude exists and rejects the fake session, or it does not exist at all.
  // Both must come back as a recorded failure, never an exception.
  assert.equal(typeof result.ok, "boolean");
  assert.ok("exit_code" in result);
});

test("the answer is passed as an argument, so shell characters cannot become commands", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-reply-"));
  const canary = path.join(dir, "pwned.txt");
  const nasty = `"; touch ${canary}; echo "`;

  await sendReply({ agent: "claude", sessionId: "no-such-session", cwd: dir, answer: nasty, timeoutMs: 4000 });

  assert.equal(
    await fs.access(canary).then(() => true, () => false),
    false,
    "an answer containing shell syntax must never be executed"
  );
});
