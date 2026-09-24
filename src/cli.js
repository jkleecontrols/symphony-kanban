#!/usr/bin/env node

import path from "node:path";
import { Logger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { createServer } from "./server.js";
import { loadWorkflow } from "./workflow.js";

const args = process.argv.slice(2);
const command = args[0] || "start";
const workflowPath = option("--workflow") || "WORKFLOW.md";
const port = Number(option("--port") || process.env.PORT || 8787);

try {
  if (command === "validate") {
    const workflow = await loadWorkflow(workflowPath);
    console.log(JSON.stringify({ ok: true, workflow_path: workflow.path, config: workflow.config }, null, 2));
  } else if (command === "once") {
    const workflow = await loadWorkflow(workflowPath);
    const logger = new Logger(path.join(workflow.dir, "data", "symphony.log.jsonl"));
    await logger.start();
    const orchestrator = new Orchestrator(workflow, logger);
    await orchestrator.runOnce();
  } else if (command === "start") {
    const workflow = await loadWorkflow(workflowPath);
    const logger = new Logger(path.join(workflow.dir, "data", "symphony.log.jsonl"));
    await logger.start();
    const orchestrator = new Orchestrator(workflow, logger);
    const server = createServer(orchestrator, logger);
    server.listen(port, "127.0.0.1", () => {
      logger.event("info", "server_started", { url: `http://127.0.0.1:${port}`, workflow_path: workflow.path });
    });
    orchestrator.start();
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, async () => {
        logger.event("info", "shutdown_requested", { signal });
        await orchestrator.stop();
        server.close(() => process.exit(0));
      });
    }
  } else {
    console.error("usage: node src/cli.js [start|validate|once] [--workflow WORKFLOW.md] [--port 8787]");
    process.exit(2);
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}
