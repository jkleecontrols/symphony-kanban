import { spawn } from "node:child_process";
import { truncate } from "./utils.js";

const OUTPUT_TAIL = 4000;

// Not workspace.js's runShell: that one throws on a non-zero exit and keeps only a slice
// of stderr. A failed check is the evidence worth keeping, so this records the exit code
// and the output instead of turning them into an exception.
export function runVerification(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > OUTPUT_TAIL * 4) output = output.slice(-OUTPUT_TAIL * 2);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finish = (exitCode, error) => {
      clearTimeout(timer);
      resolve({
        command,
        ok: exitCode === 0 && !timedOut && !error,
        exit_code: exitCode,
        timed_out: timedOut,
        error: error ? error.message : null,
        duration_ms: Date.now() - startedAt,
        output_tail: tail(output)
      });
    };

    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}

function tail(output) {
  const text = output.replace(/\r/g, "").trimEnd();
  if (text.length <= OUTPUT_TAIL) return text;
  return `…\n${text.slice(-OUTPUT_TAIL)}`;
}

// A reasonable check for a folder, offered as a suggestion rather than run unasked.
export function suggestCommand(files) {
  if (files.includes("package.json")) return "npm test";
  if (files.includes("pyproject.toml") || files.includes("pytest.ini")) return "pytest -q";
  if (files.includes("Cargo.toml")) return "cargo test";
  if (files.includes("go.mod")) return "go test ./...";
  if (files.includes("Makefile")) return "make test";
  return null;
}

// One line an operator can read at a glance, with the detail kept underneath it.
export function summarize(evidence) {
  const parts = [];
  const changes = evidence.changes;
  if (changes) {
    const bits = [];
    if (changes.commits) bits.push(`${changes.commits} commit${changes.commits > 1 ? "s" : ""}`);
    if (changes.files) bits.push(`${changes.files} file${changes.files > 1 ? "s" : ""}`);
    if (changes.insertions || changes.deletions) bits.push(`+${changes.insertions}/-${changes.deletions}`);
    parts.push(bits.length ? bits.join(", ") : "no changes");
  }
  if (evidence.verify) {
    parts.push(evidence.verify.ok ? "checks passed" : evidence.verify.timed_out ? "checks timed out" : "checks failed");
  } else {
    parts.push("no check configured");
  }
  return truncate(parts.join(" · "), 120);
}
