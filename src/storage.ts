import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ClarificationQuestion,
  ContextBundle,
  KnowledgeDocumentInput,
  StoredDocument,
  StoredTask,
  TaskInput,
} from "./domain.js";
import { chunkText } from "./text.js";

type DocumentRow = {
  id: string;
  title: string;
  content: string;
  type: string;
  source_type: KnowledgeDocumentInput["source"]["type"];
  source_id: string;
  source_url: string | null;
  domain: string | null;
  feature: string | null;
  product: string | null;
  status: KnowledgeDocumentInput["status"];
  version: number;
  effective_from: string | null;
  supersedes: string | null;
  requirements_json: string;
  unknowns_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  title: string;
  description: string;
  status: TaskInput["status"];
  parent_id: string | null;
  domain: string | null;
  feature: string | null;
  product: string | null;
  acceptance_criteria_json: string;
  unknowns_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export interface ChunkRow {
  chunkId: string;
  documentId: string;
  content: string;
  rank: number;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function toDocument(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    type: row.type,
    source: {
      type: row.source_type,
      id: row.source_id,
      ...(row.source_url ? { url: row.source_url } : {}),
    },
    context: {
      ...(row.domain ? { domain: row.domain } : {}),
      ...(row.feature ? { feature: row.feature } : {}),
      ...(row.product ? { product: row.product } : {}),
    },
    status: row.status,
    version: row.version,
    ...(row.effective_from ? { effectiveFrom: row.effective_from } : {}),
    ...(row.supersedes ? { supersedes: row.supersedes } : {}),
    requirements: parseJson(row.requirements_json),
    unknowns: parseJson(row.unknowns_json),
    relationships: [],
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTask(row: TaskRow, linkedDocumentIds: string[]): StoredTask {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    context: {
      ...(row.domain ? { domain: row.domain } : {}),
      ...(row.feature ? { feature: row.feature } : {}),
      ...(row.product ? { product: row.product } : {}),
    },
    acceptanceCriteria: parseJson(row.acceptance_criteria_json),
    linkedDocumentIds,
    unknowns: parseJson(row.unknowns_json),
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ContextDatabase {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.raw.close();
  }

  migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_url TEXT,
        domain TEXT,
        feature TEXT,
        product TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'deprecated', 'draft')),
        version INTEGER NOT NULL DEFAULT 1,
        effective_from TEXT,
        supersedes TEXT,
        requirements_json TEXT NOT NULL DEFAULT '[]',
        unknowns_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS documents_context_idx
        ON documents(status, domain, feature, product);
      CREATE INDEX IF NOT EXISTS documents_source_version_idx
        ON documents(source_type, source_id, version DESC);

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        content TEXT NOT NULL,
        UNIQUE(document_id, ordinal)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        chunk_id UNINDEXED,
        document_id UNINDEXED,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS relationships (
        from_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        to_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        PRIMARY KEY(from_document_id, to_document_id, type)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open', 'blocked', 'done')),
        parent_id TEXT,
        domain TEXT,
        feature TEXT,
        product TEXT,
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        unknowns_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_documents (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        PRIMARY KEY(task_id, document_id)
      );

      CREATE TABLE IF NOT EXISTS clarification_answers (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL,
        answer TEXT NOT NULL,
        answered_at TEXT NOT NULL,
        PRIMARY KEY(task_id, question_id)
      );
    `);
  }

  importBundle(bundle: ContextBundle): { documents: number; tasks: number } {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      for (const document of bundle.documents) this.upsertDocument(document);
      for (const document of bundle.documents) {
        this.replaceRelationships(document.id, document.relationships);
      }
      for (const task of bundle.tasks) this.upsertTask(task);
      this.raw.exec("COMMIT");
      return { documents: bundle.documents.length, tasks: bundle.tasks.length };
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  upsertDocument(document: KnowledgeDocumentInput): void {
    const now = new Date().toISOString();
    this.raw
      .prepare(`
        INSERT INTO documents (
          id, title, content, type, source_type, source_id, source_url,
          domain, feature, product, status, version, effective_from, supersedes,
          requirements_json, unknowns_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          type = excluded.type,
          source_type = excluded.source_type,
          source_id = excluded.source_id,
          source_url = excluded.source_url,
          domain = excluded.domain,
          feature = excluded.feature,
          product = excluded.product,
          status = excluded.status,
          version = excluded.version,
          effective_from = excluded.effective_from,
          supersedes = excluded.supersedes,
          requirements_json = excluded.requirements_json,
          unknowns_json = excluded.unknowns_json,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `)
      .run(
        document.id,
        document.title,
        document.content,
        document.type,
        document.source.type,
        document.source.id,
        document.source.url ?? null,
        document.context.domain ?? null,
        document.context.feature ?? null,
        document.context.product ?? null,
        document.status,
        document.version,
        document.effectiveFrom ?? null,
        document.supersedes ?? null,
        JSON.stringify(document.requirements),
        JSON.stringify(document.unknowns),
        JSON.stringify(document.metadata),
        now,
        now,
      );

    if (document.supersedes) {
      this.raw
        .prepare("UPDATE documents SET status = 'deprecated', updated_at = ? WHERE id = ?")
        .run(now, document.supersedes);
    }

    this.raw.prepare("DELETE FROM chunks_fts WHERE document_id = ?").run(document.id);
    this.raw.prepare("DELETE FROM chunks WHERE document_id = ?").run(document.id);

    const insertChunk = this.raw.prepare(
      "INSERT INTO chunks (id, document_id, ordinal, content) VALUES (?, ?, ?, ?)",
    );
    const insertFts = this.raw.prepare(
      "INSERT INTO chunks_fts (chunk_id, document_id, content) VALUES (?, ?, ?)",
    );

    chunkText(document.content).forEach((content, ordinal) => {
      const id = `${document.id}:${ordinal}`;
      insertChunk.run(id, document.id, ordinal, content);
      insertFts.run(id, document.id, `${document.title}\n${content}`);
    });
  }

  replaceRelationships(
    documentId: string,
    relationships: KnowledgeDocumentInput["relationships"],
  ): void {
    this.raw
      .prepare("DELETE FROM relationships WHERE from_document_id = ?")
      .run(documentId);
    const insert = this.raw.prepare(
      "INSERT OR IGNORE INTO relationships (from_document_id, to_document_id, type) VALUES (?, ?, ?)",
    );
    for (const relationship of relationships) {
      insert.run(documentId, relationship.to, relationship.type);
    }
  }

  upsertTask(task: TaskInput): void {
    const now = new Date().toISOString();
    this.raw
      .prepare(`
        INSERT INTO tasks (
          id, title, description, status, parent_id, domain, feature, product,
          acceptance_criteria_json, unknowns_json, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          parent_id = excluded.parent_id,
          domain = excluded.domain,
          feature = excluded.feature,
          product = excluded.product,
          acceptance_criteria_json = excluded.acceptance_criteria_json,
          unknowns_json = excluded.unknowns_json,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `)
      .run(
        task.id,
        task.title,
        task.description,
        task.status,
        task.parentId ?? null,
        task.context.domain ?? null,
        task.context.feature ?? null,
        task.context.product ?? null,
        JSON.stringify(task.acceptanceCriteria),
        JSON.stringify(task.unknowns),
        JSON.stringify(task.metadata),
        now,
        now,
      );

    this.raw.prepare("DELETE FROM task_documents WHERE task_id = ?").run(task.id);
    const link = this.raw.prepare(
      "INSERT OR IGNORE INTO task_documents (task_id, document_id) VALUES (?, ?)",
    );
    for (const documentId of task.linkedDocumentIds) link.run(task.id, documentId);
  }

  getDocument(id: string): StoredDocument | undefined {
    const row = this.raw.prepare("SELECT * FROM documents WHERE id = ?").get(id) as
      | DocumentRow
      | undefined;
    return row ? toDocument(row) : undefined;
  }

  getDocuments(ids: string[]): StoredDocument[] {
    return ids.flatMap((id) => {
      const document = this.getDocument(id);
      return document ? [document] : [];
    });
  }

  isCurrentDocument(id: string): boolean {
    const row = this.raw
      .prepare(`
        SELECT EXISTS(
          SELECT 1 FROM documents d
          WHERE d.id = ?
            AND d.status = 'active'
            AND (d.effective_from IS NULL OR d.effective_from <= date('now'))
            AND NOT EXISTS (
              SELECT 1 FROM documents newer
              WHERE newer.source_type = d.source_type
                AND newer.source_id = d.source_id
                AND newer.status = 'active'
                AND newer.version > d.version
                AND (newer.effective_from IS NULL OR newer.effective_from <= date('now'))
            )
        ) AS current
      `)
      .get(id) as { current: number };
    return row.current === 1;
  }

  getTask(id: string): StoredTask | undefined {
    const row = this.raw.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    if (!row) return undefined;
    const links = this.raw
      .prepare("SELECT document_id FROM task_documents WHERE task_id = ? ORDER BY document_id")
      .all(id) as Array<{ document_id: string }>;
    return toTask(
      row,
      links.map((link) => link.document_id),
    );
  }

  searchChunks(
    ftsQuery: string | undefined,
    filters: { domain?: string; feature?: string; product?: string; status?: string },
    limit: number,
  ): ChunkRow[] {
    const clauses = [
      "d.status = ?",
      "(d.effective_from IS NULL OR d.effective_from <= date('now'))",
      `NOT EXISTS (
        SELECT 1 FROM documents newer
        WHERE newer.source_type = d.source_type
          AND newer.source_id = d.source_id
          AND newer.status = 'active'
          AND newer.version > d.version
          AND (newer.effective_from IS NULL OR newer.effective_from <= date('now'))
      )`,
    ];
    const params: Array<string | number> = [filters.status ?? "active"];
    for (const key of ["domain", "feature", "product"] as const) {
      if (filters[key]) {
        clauses.push(`d.${key} = ?`);
        params.push(filters[key]);
      }
    }

    const where = clauses.join(" AND ");
    if (ftsQuery) {
      return this.raw
        .prepare(`
          SELECT f.chunk_id AS chunkId, f.document_id AS documentId,
                 c.content AS content, bm25(chunks_fts) AS rank
          FROM chunks_fts f
          JOIN chunks c ON c.id = f.chunk_id
          JOIN documents d ON d.id = f.document_id
          WHERE chunks_fts MATCH ? AND ${where}
          ORDER BY rank ASC
          LIMIT ?
        `)
        .all(ftsQuery, ...params, limit) as unknown as ChunkRow[];
    }

    return this.raw
      .prepare(`
        SELECT c.id AS chunkId, c.document_id AS documentId,
               c.content AS content, 0 AS rank
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        WHERE c.ordinal = 0 AND ${where}
        ORDER BY d.updated_at DESC
        LIMIT ?
      `)
      .all(...params, limit) as unknown as ChunkRow[];
  }

  relatedDocumentIds(documentIds: string[]): string[] {
    if (documentIds.length === 0) return [];
    const placeholders = documentIds.map(() => "?").join(", ");
    const rows = this.raw
      .prepare(`
        SELECT DISTINCT CASE
          WHEN from_document_id IN (${placeholders}) THEN to_document_id
          ELSE from_document_id
        END AS document_id
        FROM relationships
        WHERE from_document_id IN (${placeholders}) OR to_document_id IN (${placeholders})
      `)
      .all(...documentIds, ...documentIds, ...documentIds) as Array<{ document_id: string }>;
    return rows.map((row) => row.document_id);
  }

  saveAnswer(taskId: string, questionId: string, answer: string): void {
    this.raw
      .prepare(`
        INSERT INTO clarification_answers (task_id, question_id, answer, answered_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id, question_id) DO UPDATE SET
          answer = excluded.answer,
          answered_at = excluded.answered_at
      `)
      .run(taskId, questionId, answer, new Date().toISOString());
  }

  getAnswers(taskId: string): Record<string, string> {
    const rows = this.raw
      .prepare(
        "SELECT question_id, answer FROM clarification_answers WHERE task_id = ? ORDER BY question_id",
      )
      .all(taskId) as Array<{ question_id: string; answer: string }>;
    return Object.fromEntries(rows.map((row) => [row.question_id, row.answer]));
  }
}
