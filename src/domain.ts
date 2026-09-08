import { z } from "zod";

export const sourceTypeSchema = z.enum([
  "jira",
  "confluence",
  "adr",
  "code",
  "pull_request",
  "test",
  "manual",
]);

export const documentStatusSchema = z.enum(["active", "deprecated", "draft"]);

export const requirementSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  kind: z.enum(["verified", "inferred"]).default("verified"),
  rationale: z.string().optional(),
});

export const clarificationQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  reason: z.string().min(1),
  impact: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
  required: z.boolean().default(true),
});

export const relationshipInputSchema = z.object({
  to: z.string().min(1),
  type: z.string().min(1),
});

export const knowledgeDocumentInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  type: z.string().min(1),
  source: z.object({
    type: sourceTypeSchema,
    id: z.string().min(1),
    url: z.url().optional(),
  }),
  context: z
    .object({
      domain: z.string().optional(),
      feature: z.string().optional(),
      product: z.string().optional(),
    })
    .default({}),
  status: documentStatusSchema.default("active"),
  version: z.number().int().nonnegative().default(1),
  effectiveFrom: z.iso.date().optional(),
  supersedes: z.string().optional(),
  requirements: z.array(requirementSchema).default([]),
  unknowns: z.array(clarificationQuestionSchema).default([]),
  relationships: z.array(relationshipInputSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const taskInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  status: z.enum(["open", "blocked", "done"]).default("open"),
  parentId: z.string().optional(),
  context: z
    .object({
      domain: z.string().optional(),
      feature: z.string().optional(),
      product: z.string().optional(),
    })
    .default({}),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  linkedDocumentIds: z.array(z.string().min(1)).default([]),
  unknowns: z.array(clarificationQuestionSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const contextBundleSchema = z.object({
  documents: z.array(knowledgeDocumentInputSchema).default([]),
  tasks: z.array(taskInputSchema).default([]),
});

export type SourceType = z.infer<typeof sourceTypeSchema>;
export type KnowledgeDocumentInput = z.infer<typeof knowledgeDocumentInputSchema>;
export type RequirementInput = z.infer<typeof requirementSchema>;
export type ClarificationQuestion = z.infer<typeof clarificationQuestionSchema>;
export type TaskInput = z.infer<typeof taskInputSchema>;
export type ContextBundle = z.infer<typeof contextBundleSchema>;

export type TaskReadiness = "gathering" | "needs_clarification" | "blocked" | "ready";

export interface StoredDocument extends KnowledgeDocumentInput {
  createdAt: string;
  updatedAt: string;
}

export interface StoredTask extends TaskInput {
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceSource {
  documentId?: string;
  type: SourceType | "human";
  title: string;
  sourceId: string;
  url?: string;
  version?: number;
  status?: "active" | "deprecated" | "draft";
}

export interface EvidenceRequirement {
  id: string;
  statement: string;
  rationale?: string;
  source: EvidenceSource;
}

export interface SearchResult {
  documentId: string;
  content: string;
  score: number;
  source: EvidenceSource;
  context: KnowledgeDocumentInput["context"];
  matchedBy: Array<"lexical" | "metadata" | "relationship">;
}

export interface TaskPreparation {
  task: string;
  status: TaskReadiness;
  statusReason: string;
  understanding: {
    goal: string;
    currentBehavior?: string;
    desiredBehavior?: string;
  };
  verifiedRequirements: EvidenceRequirement[];
  inferredRequirements: EvidenceRequirement[];
  unknownRequirements: ClarificationQuestion[];
  questions: ClarificationQuestion[];
  clarificationAnswers: Record<string, string>;
  evidence: SearchResult[];
  resolvedCount: number;
}
