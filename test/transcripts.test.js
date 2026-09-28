import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeProjectDir, readActivity } from "../src/transcripts.js";

async function projectsRoot(entries) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-transcripts-"));
  for (const [dirName, records] of Object.entries(entries)) {
    const dir = path.join(root, dirName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "session.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return root;
}

test("a folder with dots or underscores resolves to its transcript directory", async () => {
  const root = await projectsRoot({
    "-Users-me-jkleecontrols-github-io": [{ type: "user", cwd: "/Users/me/jkleecontrols.github.io" }],
    "-Users-me-msg-bak": [{ type: "user", cwd: "/Users/me/msg_bak" }]
  });

  assert.equal(
    await claudeProjectDir("/Users/me/jkleecontrols.github.io", root),
    path.join(root, "-Users-me-jkleecontrols-github-io"),
    "dots must be encoded as dashes, not left alone"
  );
  assert.equal(
    await claudeProjectDir("/Users/me/msg_bak", root),
    path.join(root, "-Users-me-msg-bak"),
    "underscores must be encoded as dashes"
  );
});

test("an unknown encoding still resolves by reading the cwd the transcript records", async () => {
  const root = await projectsRoot({
    "some-future-hash-scheme": [{ type: "user", cwd: "/Users/me/weird (folder)" }]
  });
  assert.equal(
    await claudeProjectDir("/Users/me/weird (folder)", root),
    path.join(root, "some-future-hash-scheme")
  );
});

test("a folder with no transcript returns nothing rather than guessing", async () => {
  const root = await projectsRoot({ "-Users-me-other": [{ type: "user", cwd: "/Users/me/other" }] });
  assert.equal(await claudeProjectDir("/Users/me/absent", root), null);
  assert.equal(await readActivity({ name: "claude", cwd: "/Users/me/absent" }, { claude: root }), null);
});

test("activity reports the session topic and its latest tool call", async () => {
  const root = await projectsRoot({
    "-Users-me-proj": [
      { type: "user", cwd: "/Users/me/proj" },
      { type: "ai-title", aiTitle: "Personal website update" },
      { type: "assistant", timestamp: "2026-09-28T10:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "deployed the new page" }] } },
      { type: "assistant", timestamp: "2026-09-28T10:01:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }
    ]
  });

  const activity = await readActivity({ name: "claude", cwd: "/Users/me/proj" }, { claude: root });
  assert.equal(activity.title, "Personal website update");
  assert.equal(activity.activity, "using Bash", "the latest record wins");
  assert.equal(activity.at, "2026-09-28T10:01:00.000Z");
});
