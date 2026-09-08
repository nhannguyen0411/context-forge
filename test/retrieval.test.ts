import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { demoBundle } from "../src/demo.js";
import { HybridRetriever } from "../src/retrieval.js";
import { ContextDatabase } from "../src/storage.js";

describe("HybridRetriever", () => {
  let database: ContextDatabase;
  let retriever: HybridRetriever;

  beforeEach(() => {
    database = new ContextDatabase(":memory:");
    database.importBundle(demoBundle);
    retriever = new HybridRetriever(database);
  });

  afterEach(() => database.close());

  it("excludes superseded knowledge and retains source provenance", () => {
    const results = retriever.search({
      query: "priority customer daily transfer limit",
      domain: "transfer",
      limit: 10,
    });

    assert.ok(results.some((result) => result.documentId === "transfer-policy-v7"));
    assert.ok(!results.some((result) => result.documentId === "transfer-policy-v6"));
    const policy = results.find((result) => result.documentId === "transfer-policy-v7");
    assert.equal(policy?.source.version, 7);
    assert.equal(policy?.source.status, "active");
    assert.ok(policy?.matchedBy.includes("lexical"));
  });

  it("expands evidence through document relationships", () => {
    const results = retriever.search({
      query: "500,000,000 priority retail",
      domain: "transfer",
      limit: 10,
      expandRelationships: true,
    });

    const adr = results.find((result) => result.documentId === "transfer-adr");
    assert.ok(adr);
    assert.ok(adr.matchedBy.includes("relationship") || adr.matchedBy.includes("lexical"));
  });
});
