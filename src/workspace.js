import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertPathInside, pathExists, sanitizeWorkspaceKey, truncate } from "./utils.js";

export class WorkspaceManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  async prepare(issue) {
    if (issue.workspace_path) return this.prepareExternal(issue);
    await fs.mkdir(this.config.workspace.root, { recursive: true });
    const workspaceKey = sanitizeWorkspaceKey(issue.identifier);
    const workspacePath = assertPathInside(this.config.workspace.root, path.join(this.config.workspace.root, workspaceKey));
    const existed = await pathExists(workspacePath);
    if (existed) {
      const stat = await fs.stat(workspacePath);
      if (!stat.isDirectory()) throw new Error(`workspace path exists and is not a directory: ${workspacePath}`);
    } else {
      await fs.mkdir(workspacePath, { recursive: true });
      await this.runHook("after_create", workspacePath, true);
    }
    return { path: workspacePath, workspace_key: workspaceKey, created_now: !existed };
  }

  // A task may point at a folder the user already works in. That folder is theirs:
  // we never create it, never seed it with hooks, and never remove it.
  async prepareExternal(issue) {
    const workspacePath = path.resolve(issue.workspace_path);
    let stat;
    try {
      stat = await fs.stat(workspacePath);
    } catch {
      throw new Error(`workspace_path does not exist: ${workspacePath}`);
    }
    if (!stat.isDirectory()) throw new Error(`workspace_path is not a directory: ${workspacePath}`);
    this.logger.event("info", "external_workspace_used", {
      issue_id: issue.id,
      identifier: issue.identifier,
      path: workspacePath
    });
    return { path: workspacePath, workspace_key: null, created_now: false, external: true };
  }

  async beforeRun(workspacePath) {
    await this.runHook("before_run", workspacePath, true);
  }

  async afterRun(workspacePath) {
    await this.runHook("after_run", workspacePath, false);
  }

  async remove(issue) {
    if (issue.workspace_path) {
      this.logger.event("warn", "external_workspace_remove_refused", {
        issue_id: issue.id,
        identifier: issue.identifier,
        path: issue.workspace_path
      });
      return;
    }
    const workspaceKey = sanitizeWorkspaceKey(issue.identifier);
    const workspacePath = assertPathInside(this.config.workspace.root, path.join(this.config.workspace.root, workspaceKey));
    if (!(await pathExists(workspacePath))) return;
    await this.runHook("before_remove", workspacePath, false);
    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  async runHook(name, cwd, failOnError) {
    const script = this.config.hooks[name];
    if (!script) return;
    try {
      const result = await runShell(script, cwd, {}, this.config.hooks.timeout_ms);
      this.logger.event("info", "hook_completed", { hook: name, cwd, output: truncate(result.stdout || result.stderr, 1000) });
    } catch (error) {
      this.logger.event("error", "hook_failed", { hook: name, cwd, error: error.message });
      if (failOnError) throw error;
    }
  }
}

export function runShell(command, cwd, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`command failed code=${code} signal=${signal} stderr=${truncate(stderr, 1000)}`));
    });
  });
}
