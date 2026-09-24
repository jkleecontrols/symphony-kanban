import fs from "node:fs/promises";
import { nextSequence, normalizeLabel, uniqueLowerLabels, withFileLock } from "./utils.js";

export function createTracker(config) {
  if (config.tracker.kind === "local_json") return new LocalJsonTracker(config.tracker.provider.path);
  throw new Error(`unsupported tracker.kind: ${config.tracker.kind}`);
}

const MUTABLE_FIELDS = new Set([
  "title",
  "description",
  "priority",
  "state",
  "labels",
  "dispatchable",
  "agent",
  "branch_name",
  "blocked_by"
]);

export class LocalJsonTracker {
  constructor(filePath) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.secretEnvNames = [];
  }

  async fetchCandidateIssues(activeStates) {
    const issues = await this.readIssues();
    const active = new Set(activeStates);
    return issues.filter((issue) => active.has(String(issue.state).trim().toLowerCase()));
  }

  async fetchIssuesByIds(ids) {
    const wanted = new Set(ids);
    return (await this.readIssues()).filter((issue) => wanted.has(issue.id));
  }

  async fetchTerminalIssues(terminalStates) {
    const terminal = new Set(terminalStates);
    return (await this.readIssues()).filter((issue) => terminal.has(String(issue.state).trim().toLowerCase()));
  }

  async updateIssueState(id, state) {
    return this.updateIssue(id, { state });
  }

  async createIssue(input) {
    return this.mutate((issues) => {
      const id = input.id ? String(input.id) : `local-${nextSequence(issues.map((item) => item.id), /^local-(\d+)$/)}`;
      if (issues.some((item) => item.id === id)) throw new Error(`issue id already exists: ${id}`);
      const identifier = input.identifier
        ? String(input.identifier)
        : `KAN-${nextSequence(issues.map((item) => item.identifier), /^KAN-(\d+)$/)}`;
      if (issues.some((item) => item.identifier === identifier)) throw new Error(`issue identifier already exists: ${identifier}`);

      const now = new Date().toISOString();
      const created = {
        id,
        native_ref: { source: "local-json" },
        identifier,
        title: String(input.title ?? "").trim(),
        description: input.description == null ? null : String(input.description),
        priority: input.priority == null || input.priority === "" ? null : Number(input.priority),
        state: requiredString(input.state, "state"),
        branch_name: input.branch_name == null ? null : String(input.branch_name),
        url: null,
        assignee_id: null,
        labels: uniqueLowerLabels(input.labels),
        blocked_by: normalizeBlockers(input.blocked_by),
        dispatchable: Boolean(input.dispatchable),
        agent: input.agent == null || input.agent === "" ? null : String(input.agent),
        created_at: now,
        updated_at: now
      };
      if (!created.title) throw new Error("issue.title is required");
      issues.push(created);
      return created;
    });
  }

  async updateIssue(id, patch) {
    return this.mutate((issues) => {
      const issue = issues.find((item) => item.id === id);
      if (!issue) return null;
      for (const [key, value] of Object.entries(patch || {})) {
        if (!MUTABLE_FIELDS.has(key)) continue;
        if (key === "labels") issue.labels = uniqueLowerLabels(value);
        else if (key === "blocked_by") issue.blocked_by = normalizeBlockers(value);
        else if (key === "dispatchable") issue.dispatchable = Boolean(value);
        else if (key === "priority") issue.priority = value == null || value === "" ? null : Number(value);
        else if (key === "agent") issue.agent = value == null || value === "" ? null : String(value);
        else if (key === "title") issue.title = String(value ?? "").trim();
        else issue[key] = value == null ? null : String(value);
      }
      if (patch && "title" in patch && !issue.title) throw new Error("issue.title is required");
      issue.updated_at = new Date().toISOString();
      return issue;
    });
  }

  async deleteIssue(id) {
    return this.mutate((issues) => {
      const index = issues.findIndex((item) => item.id === id);
      if (index === -1) return null;
      const [removed] = issues.splice(index, 1);
      return removed;
    });
  }

  async readIssues() {
    return (await this.readRawIssues()).map(normalizeIssue);
  }

  async readRawIssues() {
    const source = await fs.readFile(this.filePath, "utf8");
    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed)) throw new Error("local_json tracker file must contain an array");
    return parsed;
  }

  async mutate(fn) {
    return withFileLock(this.lockPath, async () => {
      const issues = await this.readRawIssues();
      const result = fn(issues);
      if (result === null) return null;
      await this.writeRawIssues(issues);
      return normalizeIssue(result);
    });
  }

  async writeRawIssues(issues) {
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(issues, null, 2)}\n`);
    await fs.rename(tempPath, this.filePath);
  }
}

export function normalizeIssue(input) {
  return {
    id: requiredString(input.id, "id"),
    native_ref: input.native_ref && typeof input.native_ref === "object" ? input.native_ref : null,
    identifier: requiredString(input.identifier, "identifier"),
    title: String(input.title ?? ""),
    description: input.description == null ? null : String(input.description),
    priority: input.priority == null ? null : Number(input.priority),
    state: requiredString(input.state, "state"),
    branch_name: input.branch_name == null ? null : String(input.branch_name),
    url: input.url == null ? null : String(input.url),
    assignee_id: input.assignee_id == null ? null : String(input.assignee_id),
    labels: uniqueLowerLabels(input.labels),
    blocked_by: normalizeBlockers(input.blocked_by),
    dispatchable: Boolean(input.dispatchable),
    agent: input.agent == null || input.agent === "" ? null : String(input.agent),
    created_at: input.created_at ?? null,
    updated_at: input.updated_at ?? null
  };
}

export function issueHasRequiredLabels(issue, requiredLabels) {
  const labels = new Set(issue.labels.map(normalizeLabel));
  return requiredLabels.every((label) => label && labels.has(label));
}

function normalizeBlockers(blockers) {
  if (!Array.isArray(blockers)) return [];
  return blockers.map((blocker) => ({
    id: blocker?.id == null ? null : String(blocker.id),
    identifier: blocker?.identifier == null ? null : String(blocker.identifier),
    state: blocker?.state == null ? null : String(blocker.state)
  }));
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`issue.${field} is required`);
  return value;
}
