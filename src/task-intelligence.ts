import type {
  ClarificationQuestion,
  EvidenceRequirement,
  SearchResult,
  StoredDocument,
  TaskPreparation,
} from "./domain.js";
import { HybridRetriever } from "./retrieval.js";
import { ContextDatabase } from "./storage.js";

export interface PrepareTaskOptions {
  answers?: Record<string, string>;
  persistAnswers?: boolean;
  evidenceLimit?: number;
}

function requirementFromDocument(
  document: StoredDocument,
  requirement: StoredDocument["requirements"][number],
): EvidenceRequirement {
  return {
    id: requirement.id,
    statement: requirement.statement,
    ...(requirement.rationale ? { rationale: requirement.rationale } : {}),
    source: {
      documentId: document.id,
      type: document.source.type,
      title: document.title,
      sourceId: document.source.id,
      ...(document.source.url ? { url: document.source.url } : {}),
      version: document.version,
      status: document.status,
    },
  };
}

function uniqueQuestions(questions: ClarificationQuestion[]): ClarificationQuestion[] {
  return [...new Map(questions.map((question) => [question.id, question])).values()];
}

function uniqueEvidence(evidence: SearchResult[]): SearchResult[] {
  return [...new Map(evidence.map((item) => [item.documentId, item])).values()];
}

export class TaskIntelligence {
  constructor(
    private readonly database: ContextDatabase,
    private readonly retriever: HybridRetriever,
  ) {}

  prepare(taskId: string, options: PrepareTaskOptions = {}): TaskPreparation {
    const task = this.database.getTask(taskId);
    if (!task) {
      return {
        task: taskId,
        status: "blocked",
        statusReason: `Task ${taskId} does not exist in the context index.`,
        understanding: { goal: "Unknown task" },
        verifiedRequirements: [],
        inferredRequirements: [],
        unknownRequirements: [],
        questions: [],
        clarificationAnswers: {},
        evidence: [],
        resolvedCount: 0,
      };
    }

    if (options.answers && options.persistAnswers !== false) {
      for (const [questionId, answer] of Object.entries(options.answers)) {
        if (answer.trim()) this.database.saveAnswer(taskId, questionId, answer.trim());
      }
    }

    const answers = {
      ...this.database.getAnswers(taskId),
      ...options.answers,
    };
    const directEvidence = this.retriever.evidenceForDocuments(task.linkedDocumentIds);
    const retrieved = this.retriever.search({
      query: `${task.title} ${task.description}`,
      ...(task.context.domain ? { domain: task.context.domain } : {}),
      ...(task.context.feature ? { feature: task.context.feature } : {}),
      ...(task.context.product ? { product: task.context.product } : {}),
      limit: options.evidenceLimit ?? 12,
      expandRelationships: true,
    });
    const evidence = uniqueEvidence([
      ...directEvidence,
      ...retrieved,
    ]);
    const evidenceDocuments = this.database.getDocuments(
      evidence.map((item) => item.documentId),
    );

    const verifiedRequirements: EvidenceRequirement[] = task.acceptanceCriteria.map(
      (statement, index) => ({
        id: `${task.id}.acceptance.${index + 1}`,
        statement,
        source: {
          type: "jira",
          title: task.title,
          sourceId: task.id,
        },
      }),
    );
    const inferredRequirements: EvidenceRequirement[] = [];
    const discoveredQuestions: ClarificationQuestion[] = [...task.unknowns];

    for (const document of evidenceDocuments) {
      for (const requirement of document.requirements) {
        const target = requirement.kind === "inferred" ? inferredRequirements : verifiedRequirements;
        target.push(requirementFromDocument(document, requirement));
      }
      discoveredQuestions.push(...document.unknowns);
    }

    const conflictQuestions = this.findConflicts(verifiedRequirements);
    const allQuestions = uniqueQuestions([...discoveredQuestions, ...conflictQuestions]);
    const unanswered = allQuestions.filter(
      (question) => question.required && !answers[question.id]?.trim(),
    );

    for (const question of allQuestions) {
      const answer = answers[question.id]?.trim();
      if (!answer) continue;
      verifiedRequirements.push({
        id: `clarification.${question.id}`,
        statement: `${question.question} Answer: ${answer}`,
        source: {
          type: "human",
          title: `Clarification for ${task.id}`,
          sourceId: `${task.id}:${question.id}`,
        },
      });
    }

    let status: TaskPreparation["status"];
    let statusReason: string;
    if (task.status === "blocked") {
      status = "blocked";
      statusReason = "The source task is explicitly marked as blocked.";
    } else if (unanswered.length > 0) {
      status = "needs_clarification";
      statusReason = `${unanswered.length} implementation-critical requirement${unanswered.length === 1 ? " is" : "s are"} unresolved.`;
    } else if (verifiedRequirements.length === 0 || evidence.length === 0) {
      status = "gathering";
      statusReason = "No verified requirement evidence is available yet.";
    } else {
      status = "ready";
      statusReason = "The available evidence is sufficient to create an implementation plan.";
    }

    return {
      task: task.id,
      status,
      statusReason,
      understanding: {
        goal: task.title,
        currentBehavior:
          typeof task.metadata.currentBehavior === "string"
            ? task.metadata.currentBehavior
            : task.description,
        ...(typeof task.metadata.desiredBehavior === "string"
          ? { desiredBehavior: task.metadata.desiredBehavior }
          : {}),
      },
      verifiedRequirements,
      inferredRequirements,
      unknownRequirements: unanswered,
      questions: unanswered,
      clarificationAnswers: answers,
      evidence,
      resolvedCount: allQuestions.length - unanswered.length,
    };
  }

  private findConflicts(requirements: EvidenceRequirement[]): ClarificationQuestion[] {
    const statementsById = new Map<string, Set<string>>();
    for (const requirement of requirements) {
      const statements = statementsById.get(requirement.id) ?? new Set<string>();
      statements.add(requirement.statement.trim());
      statementsById.set(requirement.id, statements);
    }

    return [...statementsById.entries()].flatMap(([id, statements]) => {
      if (statements.size < 2) return [];
      return [
        {
          id: `conflict.${id}`,
          question: `Which value is authoritative for requirement “${id}”?`,
          reason: "Active evidence sources disagree on the same requirement.",
          impact: "Implementing either value without confirmation may violate a business rule.",
          options: [...statements],
          required: true,
        },
      ];
    });
  }
}
