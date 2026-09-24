import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeState(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeLabel(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function uniqueLowerLabels(labels) {
  return [...new Set((Array.isArray(labels) ? labels : []).map(normalizeLabel).filter(Boolean))];
}

export function sanitizeWorkspaceKey(identifier) {
  const raw = String(identifier);
  const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized === raw) return sanitized;
  const suffix = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `${sanitized}_${suffix}`;
}

export function assertPathInside(parent, child) {
  const parentPath = path.resolve(parent);
  const childPath = path.resolve(child);
  const relative = path.relative(parentPath, childPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return childPath;
  throw new Error(`path escapes workspace root: ${childPath}`);
}

export function expandPathValue(value, baseDir, env = process.env) {
  let output = String(value);
  if (output === "~" || output.startsWith("~/")) {
    output = path.join(env.HOME || process.cwd(), output.slice(2));
  }
  output = output.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => env[name] || "");
  if (!path.isAbsolute(output)) output = path.resolve(baseDir, output);
  return path.normalize(output);
}

export function resolveEnvRef(value, env = process.env) {
  if (typeof value !== "string") return value;
  const match = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) return value;
  return env[match[1]] || "";
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(value, max = 2000) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function makeId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}
