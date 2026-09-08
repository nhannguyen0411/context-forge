import { contextBundleSchema } from "./domain.js";

export const demoBundle = contextBundleSchema.parse({
  documents: [
    {
      id: "transfer-policy-v6",
      title: "Transfer Limit Policy v6",
      content:
        "Priority retail customers have a daily domestic transfer limit of 200,000,000 VND. Limits are aggregated per CIF.",
      type: "business_rule",
      source: {
        type: "confluence",
        id: "transfer-policy",
        url: "https://example.invalid/wiki/transfer-policy-v6",
      },
      context: {
        domain: "transfer",
        feature: "daily-limit",
        product: "retail-banking",
      },
      status: "active",
      version: 6,
      requirements: [
        {
          id: "daily-limit.amount",
          statement: "Priority retail customers have a 200,000,000 VND daily limit.",
        },
        {
          id: "daily-limit.scope",
          statement: "Daily transfer totals are aggregated per CIF.",
        },
      ],
    },
    {
      id: "transfer-policy-v7",
      title: "Transfer Limit Policy v7",
      content:
        "From 2026-01-01, priority retail customers have a daily domestic transfer limit of 500,000,000 VND. Limits remain aggregated per CIF.",
      type: "business_rule",
      source: {
        type: "confluence",
        id: "transfer-policy",
        url: "https://example.invalid/wiki/transfer-policy-v7",
      },
      context: {
        domain: "transfer",
        feature: "daily-limit",
        product: "retail-banking",
      },
      status: "active",
      version: 7,
      effectiveFrom: "2026-01-01",
      supersedes: "transfer-policy-v6",
      requirements: [
        {
          id: "daily-limit.amount",
          statement: "Priority retail customers have a 500,000,000 VND daily limit.",
        },
        {
          id: "daily-limit.scope",
          statement: "Daily transfer totals are aggregated per CIF.",
        },
      ],
      relationships: [{ to: "transfer-adr", type: "governed_by" }],
    },
    {
      id: "transfer-adr",
      title: "ADR-014 Transfer limit aggregation",
      content:
        "All retail transfer limits are calculated by CIF and reset at midnight Asia/Ho_Chi_Minh.",
      type: "decision",
      source: { type: "adr", id: "ADR-014" },
      context: {
        domain: "transfer",
        feature: "daily-limit",
        product: "retail-banking",
      },
      requirements: [
        {
          id: "daily-limit.timezone",
          statement: "The daily window resets at midnight Asia/Ho_Chi_Minh.",
        },
      ],
    },
  ],
  tasks: [
    {
      id: "PAY-381",
      title: "Increase transfer limit for priority customers",
      description:
        "Raise the daily domestic transfer limit for priority retail customers from 200M to 500M VND.",
      context: {
        domain: "transfer",
        feature: "daily-limit",
        product: "retail-banking",
      },
      acceptanceCriteria: [
        "The configured daily transfer limit for priority retail customers is 500,000,000 VND.",
      ],
      linkedDocumentIds: ["transfer-policy-v7"],
      unknowns: [
        {
          id: "scheduled-transfer-reservation",
          question: "Should pending scheduled transfers reserve part of the daily limit?",
          reason: "Neither Jira nor the active policy defines reservation behavior.",
          impact: "This determines whether pending scheduled transfers reduce the remaining limit.",
          options: ["yes", "no"],
        },
        {
          id: "existing-customer-rollout",
          question: "Should the new limit apply immediately to existing priority customers?",
          reason: "The rollout policy is not documented.",
          impact: "This changes whether migration or effective-date gating is required.",
          options: ["immediately", "new-customers-only", "other"],
        },
      ],
      metadata: {
        currentBehavior: "Priority retail customers are limited to 200M VND per CIF per day.",
        desiredBehavior: "Increase the limit to 500M VND while preserving existing aggregation rules.",
      },
    },
  ],
});
