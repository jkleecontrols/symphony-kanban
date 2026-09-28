import { spawn } from "node:child_process";

const OUTPUT_TAIL = 3000;

// Resuming a conversation by id starts a NEW process on it. That is safe only when the
// interactive session is gone; beside an open terminal the two write over each other.
// The caller checks that; these are the invocations for each CLI.
const RESUME = {
  claude: (sessionId, answer) => ({ file: "claude", args: ["--resume", sessionId, "--print", answer] }),
  codex: (sessionId, answer) => ({ file: "codex", args: ["exec", "resume", sessionId, answer] })
};

export function canReplyTo(agentName) {
  return Object.hasOwn(RESUME, agentName);
}

export function supportedAgents() {
  return Object.keys(RESUME);
}

// The answer is passed as an argv entry, never through a shell, so quotes, newlines and
// backticks in what the operator typed cannot become commands.
export function sendReply({ agent, sessionId, cwd, answer, timeoutMs }) {
  return new Promise((resolve) => {
    const build = RESUME[agent];
    if (!build) {
      resolve({ ok: false, error: `no resume command known for ${agent}`, exit_code: null, output_tail: "" });
      return;
    }

    const { file, args } = build(sessionId, answer);
    const startedAt = Date.now();
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
  return text.length <= OUTPUT_TAIL ? text : `…\n${text.slice(-OUTPUT_TAIL)}`;
}
