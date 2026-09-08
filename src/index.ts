#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { databasePath } from "./config.js";
import { HybridRetriever } from "./retrieval.js";
import { createContextForgeServer } from "./server.js";
import { ContextDatabase } from "./storage.js";
import { TaskIntelligence } from "./task-intelligence.js";

const database = new ContextDatabase(databasePath());
const retriever = new HybridRetriever(database);
const taskIntelligence = new TaskIntelligence(database, retriever);

const handle = serveStdio(
  (requestContext) =>
    createContextForgeServer(
      { database, retriever, taskIntelligence },
      requestContext,
    ),
  {
    onerror: (error) => console.error("[context-forge]", error),
  },
);

const shutdown = async () => {
  await handle.close();
  database.close();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
