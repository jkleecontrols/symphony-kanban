import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createTracker } from "./tracker.js";

export function createServer(orchestrator, logger) {
  const publicDir = path.resolve(orchestrator.workflow.dir, "public");
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/state") return json(res, orchestrator.snapshot());
      if (url.pathname === "/api/issues") {
        const tracker = createTracker(orchestrator.config);
        return json(res, await tracker.readIssues());
      }
      if (url.pathname === "/api/logs") return json(res, logger.recent.slice(-200));
      if (url.pathname === "/api/poll" && req.method === "POST") {
        await orchestrator.poll();
        return json(res, { ok: true });
      }
      if (url.pathname.startsWith("/api/issues/") && req.method === "PATCH") {
        const id = decodeURIComponent(url.pathname.split("/")[3]);
        const body = await readJson(req);
        if (body.state) {
          const updated = await orchestrator.tracker.updateIssueState(id, body.state);
          return json(res, { ok: true, issue: updated });
        }
      }
      if (url.pathname.startsWith("/api/retry/") && req.method === "POST") {
        await orchestrator.retry(decodeURIComponent(url.pathname.split("/").at(-1)));
        return json(res, { ok: true });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return file(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
      }
      const staticPath = path.normalize(path.join(publicDir, url.pathname));
      if (!staticPath.startsWith(publicDir)) return notFound(res);
      const type = contentType(staticPath);
      return file(res, staticPath, type);
    } catch (error) {
      logger.event("error", "http_request_failed", { error: error.message });
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
}

function json(res, value) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value, null, 2));
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

async function file(res, filePath, type) {
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "content-type": type });
    res.end(content);
  } catch {
    notFound(res);
  }
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}
