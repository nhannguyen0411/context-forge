import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { demoBundle } from "../src/demo.js";
import { HybridRetriever } from "../src/retrieval.js";
import { createContextForgeServer } from "../src/server.js";
import { ContextDatabase } from "../src/storage.js";
import { TaskIntelligence } from "../src/task-intelligence.js";

describe("ContextForge MCP server", () => {
  let database: ContextDatabase;

  beforeEach(() => {
    database = new ContextDatabase(":memory:");
    database.importBundle(demoBundle);
  });

  afterEach(() => database.close());

  it("exposes the portable clarification fallback over MCP", async () => {
    const retriever = new HybridRetriever(database);
    const taskIntelligence = new TaskIntelligence(database, retriever);
    const server = createContextForgeServer({ database, retriever, taskIntelligence });
    const client = new Client({ name: "context-forge-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "prepare_task"));
      assert.ok(tools.tools.some((tool) => tool.name === "search_context"));

      const result = await client.callTool({
        name: "prepare_task",
        arguments: { taskId: "PAY-381", elicitation: "auto" },
      });
      const structured = result.structuredContent as {
        status: string;
        questions: Array<{ id: string }>;
      };
      assert.equal(structured.status, "needs_clarification");
      assert.equal(structured.questions.length, 2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("collects missing requirements through MCP elicitation when supported", async () => {
    const retriever = new HybridRetriever(database);
    const taskIntelligence = new TaskIntelligence(database, retriever);
    const server = createContextForgeServer({ database, retriever, taskIntelligence });
    const client = new Client(
      { name: "context-forge-interactive-test", version: "1.0.0" },
      { capabilities: { elicitation: {} } },
    );
    client.setRequestHandler("elicitation/create", async (request) => ({
      action: "accept" as const,
      content: {
        answer: request.params.message.includes("pending scheduled") ? "yes" : "immediately",
      },
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "prepare_task",
        arguments: { taskId: "PAY-381", elicitation: "auto" },
      });
      const structured = result.structuredContent as {
        status: string;
        clarificationAnswers: Record<string, string>;
      };
      assert.equal(structured.status, "ready");
      assert.equal(structured.clarificationAnswers["scheduled-transfer-reservation"], "yes");
      assert.equal(structured.clarificationAnswers["existing-customer-rollout"], "immediately");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
