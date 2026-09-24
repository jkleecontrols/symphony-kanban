import fs from "node:fs/promises";
import { normalizeLabel, uniqueLowerLabels } from "./utils.js";

export function createTracker(config) {
  if (config.tracker.kind === "local_json") return new LocalJsonTracker(config.tracker.provider.path);
  throw new Error(`unsupported tracker.kind: ${config.tracker.kind}`);
}

export class LocalJsonTracker {
  constructor(filePath) {
    this.filePath = filePath;
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
    const issues = await this.readRawIssues();
    const issue = issues.find((item) => item.id === id);
    if (!issue) return null;
    issue.state = state;
    issue.updated_at = new Date().toISOString();
    await fs.writeFile(this.filePath, `${JSON.stringify(issues, null, 2)}\n`);
    return normalizeIssue(issue);
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
