import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  McpServer,
  type ClientCapabilities,
  type McpRequestContext,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { contextBundleSchema } from "./domain.js";
import { HybridRetriever } from "./retrieval.js";
import { ContextDatabase } from "./storage.js";
import { TaskIntelligence } from "./task-intelligence.js";

export interface ContextForgeDependencies {
  database: ContextDatabase;
  retriever: HybridRetriever;
  taskIntelligence: TaskIntelligence;
}

function toolResult(value: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function createContextForgeServer(
  dependencies: ContextForgeDependencies,
  requestContext: McpRequestContext = { era: "legacy" },
): McpServer {
  const server = new McpServer(
    { name: "context-forge", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        "Before implementing an engineering task, call prepare_task. Only implement when its status is ready. If it returns needs_clarification and the client cannot display MCP elicitation, relay questions[] to the user without changing their meaning. Treat verifiedRequirements as sourced facts, inferredRequirements only as hypotheses, and never invent answers for unknownRequirements. Use search_context when additional evidence is needed; prefer active, current-version sources.",
      inputRequired: { legacyShim: true, maxRounds: 4 },
    },
  );

  const supportsFormElicitation = (context: ServerContext): boolean => {
    let capabilities: ClientCapabilities | undefined;
    if (requestContext.era === "modern") {
      const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
      capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
    } else {
      capabilities = server.server.getClientCapabilities();
    }
    const elicitation = capabilities?.elicitation;
    if (!elicitation) return false;
    // Legacy clients declared form elicitation with a bare `elicitation: {}`.
    return requestContext.era === "legacy" || elicitation.form !== undefined;
  };

  server.registerTool(
    "search_context",
    {
      title: "Search company context",
      description:
        "Hybrid lexical, metadata, and relationship retrieval. Results retain source, version, status, and match provenance.",
      inputSchema: z.object({
        query: z.string().min(1),
        domain: z.string().optional(),
        feature: z.string().optional(),
        product: z.string().optional(),
        status: z.enum(["active", "deprecated", "draft"]).default("active"),
        limit: z.number().int().min(1).max(50).default(10),
        expandRelationships: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      toolResult({
        results: dependencies.retriever.search({
          query: input.query,
          ...(input.domain ? { domain: input.domain } : {}),
          ...(input.feature ? { feature: input.feature } : {}),
          ...(input.product ? { product: input.product } : {}),
          status: input.status,
          limit: input.limit,
          expandRelationships: input.expandRelationships,
        }),
      }),
  );

  server.registerTool(
    "prepare_task",
    {
      title: "Prepare an engineering task",
      description:
        "Investigates a task, separates verified facts from inference, and decides whether implementation is safe. Uses MCP elicitation when supported; otherwise returns structured clarification questions for the coding agent to ask.",
      inputSchema: z.object({
        taskId: z.string().min(1),
        answers: z.record(z.string(), z.string()).optional(),
        elicitation: z.enum(["auto", "never"]).default("auto"),
        persistAnswers: z.boolean().default(true),
        evidenceLimit: z.number().int().min(1).max(50).default(12),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (input, context) => {
      let preparation = dependencies.taskIntelligence.prepare(input.taskId, {
        ...(input.answers ? { answers: input.answers } : {}),
        persistAnswers: input.persistAnswers,
        evidenceLimit: input.evidenceLimit,
      });

      const elicitedAnswers: Record<string, string> = {};
      for (const question of preparation.questions) {
        const response = acceptedContent<{ answer: string }>(
          context.mcpReq.inputResponses,
          question.id,
        );
        if (typeof response?.answer === "string" && response.answer.trim()) {
          elicitedAnswers[question.id] = response.answer.trim();
        }
      }

      if (Object.keys(elicitedAnswers).length > 0) {
        preparation = dependencies.taskIntelligence.prepare(input.taskId, {
          answers: elicitedAnswers,
          persistAnswers: input.persistAnswers,
          evidenceLimit: input.evidenceLimit,
        });
      }

      if (
        preparation.status === "needs_clarification" &&
        input.elicitation === "auto" &&
        supportsFormElicitation(context)
      ) {
        return inputRequired({
          inputRequests: Object.fromEntries(
            preparation.questions.map((question) => [
              question.id,
              inputRequired.elicit({
                message: `${question.question}\n\nWhy this is needed: ${question.reason}\nImpact: ${question.impact}`,
                requestedSchema: {
                  type: "object",
                  properties: {
                    answer:
                      question.options && question.options.length > 0
                        ? { type: "string", enum: question.options }
                        : { type: "string" },
                  },
                  required: ["answer"],
                },
              }),
            ]),
          ),
        });
      }

      return toolResult(preparation);
    },
  );

  server.registerTool(
    "resolve_unknown",
    {
      title: "Resolve a task uncertainty",
      description:
        "Records a human answer to one clarification question, then re-evaluates task readiness.",
      inputSchema: z.object({
        taskId: z.string().min(1),
        questionId: z.string().min(1),
        answer: z.string().min(1),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ taskId, questionId, answer }) => {
      const preparation = dependencies.taskIntelligence.prepare(taskId, {
        answers: { [questionId]: answer },
        persistAnswers: true,
      });
      return toolResult(preparation);
    },
  );

  server.registerTool(
    "task_status",
    {
      title: "Get task readiness",
      description:
        "Returns the current deterministic readiness assessment without opening an elicitation flow.",
      inputSchema: z.object({ taskId: z.string().min(1) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ taskId }) => toolResult(dependencies.taskIntelligence.prepare(taskId)),
  );

  server.registerTool(
    "ingest_context",
    {
      title: "Ingest context",
      description:
        "Upserts structured documents and tasks into the local ContextForge knowledge index.",
      inputSchema: contextBundleSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (bundle) => toolResult(dependencies.database.importBundle(bundle)),
  );

  server.registerResource(
    "health",
    "context-forge://health",
    { title: "ContextForge health", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ status: "ok", version: "0.1.0" }),
        },
      ],
    }),
  );

  return server;
}
