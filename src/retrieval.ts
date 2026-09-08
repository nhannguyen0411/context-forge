import type { EvidenceSource, SearchResult, StoredDocument } from "./domain.js";
import { ContextDatabase } from "./storage.js";
import { tokenOverlap, toFtsQuery } from "./text.js";

export interface SearchOptions {
  query: string;
  domain?: string;
  feature?: string;
  product?: string;
  status?: "active" | "deprecated" | "draft";
  limit?: number;
  expandRelationships?: boolean;
}

function sourceFor(document: StoredDocument): EvidenceSource {
  return {
    documentId: document.id,
    type: document.source.type,
    title: document.title,
    sourceId: document.source.id,
    ...(document.source.url ? { url: document.source.url } : {}),
    version: document.version,
    status: document.status,
  };
}

export class HybridRetriever {
  constructor(private readonly database: ContextDatabase) {}

  search(options: SearchOptions): SearchResult[] {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const ftsQuery = toFtsQuery(options.query);
    const rows = this.database.searchChunks(
      ftsQuery,
      {
        ...(options.domain ? { domain: options.domain } : {}),
        ...(options.feature ? { feature: options.feature } : {}),
        ...(options.product ? { product: options.product } : {}),
        status: options.status ?? "active",
      },
      limit * 3,
    );

    const results = new Map<string, SearchResult>();
    for (const row of rows) {
      const document = this.database.getDocument(row.documentId);
      if (!document) continue;
      const overlap = tokenOverlap(options.query, `${document.title}\n${row.content}`);
      const lexicalScore = ftsQuery ? 1 / (1 + Math.abs(row.rank)) : 0;
      const metadataScore = this.metadataScore(document, options);
      const score = lexicalScore * 0.7 + overlap * 0.2 + metadataScore * 0.1;
      const result: SearchResult = {
        documentId: document.id,
        content: row.content,
        score: Number(score.toFixed(6)),
        source: sourceFor(document),
        context: document.context,
        matchedBy: [
          ...(ftsQuery ? (["lexical"] as const) : []),
          ...(metadataScore > 0 ? (["metadata"] as const) : []),
        ],
      };
      const existing = results.get(document.id);
      if (!existing || result.score > existing.score) results.set(document.id, result);
    }

    if (options.expandRelationships !== false && results.size > 0) {
      const relatedIds = this.database.relatedDocumentIds([...results.keys()]);
      for (const document of this.database.getDocuments(relatedIds)) {
        if (document.status !== (options.status ?? "active") || results.has(document.id)) continue;
        results.set(document.id, {
          documentId: document.id,
          content: document.content.slice(0, 1_200),
          score: 0.15,
          source: sourceFor(document),
          context: document.context,
          matchedBy: ["relationship"],
        });
      }
    }

    return [...results.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  evidenceForDocuments(documentIds: string[]): SearchResult[] {
    return this.database
      .getDocuments(documentIds)
      .filter((document) => this.database.isCurrentDocument(document.id))
      .map((document) => ({
        documentId: document.id,
        content: document.content.slice(0, 1_200),
        score: 1,
        source: sourceFor(document),
        context: document.context,
        matchedBy: ["relationship"],
      }));
  }

  private metadataScore(document: StoredDocument, options: SearchOptions): number {
    const filters = [
      [options.domain, document.context.domain],
      [options.feature, document.context.feature],
      [options.product, document.context.product],
    ].filter(([expected]) => expected !== undefined);
    if (filters.length === 0) return 0;
    return filters.every(([expected, actual]) => expected === actual) ? 1 : 0;
  }
}
