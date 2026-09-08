import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { contextBundleSchema } from "../src/domain.js";
import { demoBundle } from "../src/demo.js";
import { HybridRetriever } from "../src/retrieval.js";
import { ContextDatabase } from "../src/storage.js";
import { TaskIntelligence } from "../src/task-intelligence.js";

describe("TaskIntelligence", () => {
  let database: ContextDatabase;
  let intelligence: TaskIntelligence;

  beforeEach(() => {
    database = new ContextDatabase(":memory:");
    database.importBundle(demoBundle);
    intelligence = new TaskIntelligence(database, new HybridRetriever(database));
  });

  afterEach(() => database.close());

  it("stops implementation when critical requirements are unresolved", () => {
    const result = intelligence.prepare("PAY-381");

    assert.equal(result.status, "needs_clarification");
    assert.deepEqual(
      result.questions.map((question) => question.id).sort(),
      ["existing-customer-rollout", "scheduled-transfer-reservation"],
    );
    assert.ok(
      result.verifiedRequirements.some(
        (requirement) => requirement.id === "daily-limit.amount",
      ),
    );
  });

  it("becomes ready after all clarification answers are recorded", () => {
    const result = intelligence.prepare("PAY-381", {
      answers: {
        "scheduled-transfer-reservation": "yes",
        "existing-customer-rollout": "immediately",
      },
    });

    assert.equal(result.status, "ready");
    assert.equal(result.questions.length, 0);
    assert.equal(result.resolvedCount, 2);
    assert.equal(result.clarificationAnswers["scheduled-transfer-reservation"], "yes");
    assert.ok(
      result.verifiedRequirements.some(
        (requirement) => requirement.id === "clarification.existing-customer-rollout",
      ),
    );
  });

  it("turns conflicting active evidence into a clarification question", () => {
    database.importBundle(
      contextBundleSchema.parse({
        documents: [
          {
            id: "conflicting-policy",
            title: "Conflicting policy",
            content: "Priority limit is 600M VND.",
            type: "business_rule",
            source: { type: "manual", id: "conflicting-policy" },
            context: {
              domain: "transfer",
              feature: "daily-limit",
              product: "retail-banking",
            },
            requirements: [
              {
                id: "daily-limit.amount",
                statement: "Priority retail customers have a 600,000,000 VND daily limit.",
              },
            ],
          },
        ],
        tasks: [],
      }),
    );

    const result = intelligence.prepare("PAY-381");
    assert.ok(result.questions.some((question) => question.id === "conflict.daily-limit.amount"));
  });

  it("blocks an unknown task rather than inventing requirements", () => {
    const result = intelligence.prepare("PAY-999");
    assert.equal(result.status, "blocked");
    assert.equal(result.verifiedRequirements.length, 0);
  });
});
