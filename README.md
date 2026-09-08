# ContextForge

ContextForge is an MCP server that decides whether a coding agent has enough evidence to implement an engineering task safely.

It is intentionally more than a text-retrieval wrapper. ContextForge keeps source provenance, document versions, lifecycle status, task relationships, verified requirements, inferences, and unresolved questions as separate data.

## What is implemented

- SQLite-backed document and task index
- FTS5 lexical retrieval for identifiers, symbols, API routes, and exact domain language
- Metadata filters for domain, feature, product, lifecycle status, and effective date
- Supersession and current-version handling so deprecated policy is excluded by default
- Relationship expansion across business rules, ADRs, code, tests, tickets, and PRs
- Deterministic task-readiness states: `gathering`, `needs_clarification`, `blocked`, and `ready`
- Explicit separation of `verifiedRequirements`, `inferredRequirements`, and `unknownRequirements`
- Conflict detection when active evidence disagrees about the same requirement
- Native MCP `input_required` elicitation when the client supports it
- Portable structured-question fallback when the client does not support elicitation
- JSON bundle ingestion through both a CLI and an MCP tool

The current retrieval implementation is the lightweight first stage: FTS + metadata + relationships + deterministic reranking. Embedding/vector retrieval can be added as another candidate source without changing the task-intelligence contract.

## Architecture

```text
Coding agent
    |
    v
prepare_task(taskId)
    |
    +--> task + linked evidence
    +--> FTS / metadata retrieval
    +--> relationship expansion
    +--> source/version filtering
    |
    v
Requirement analysis
    |
    +--> verified facts
    +--> explicit inferences
    +--> conflicts / unknowns
    |
    +--> ready ----------------------> implementation plan
    |
    +--> needs_clarification
              |
              +--> MCP elicitation, when supported
              +--> structured questions[], otherwise
```

## Requirements

- Node.js 24 or newer
- npm

The project uses Node's built-in `node:sqlite`, so no native SQLite package needs to be compiled.

## Get started

```bash
npm install
npm run build
npm run seed
npm test
```

The seed command creates `.context-forge/context-forge.db` and imports the `PAY-381` example discussed during project design.

Run the STDIO MCP server:

```bash
npm start
```

Override the database location when needed:

```bash
CONTEXT_FORGE_DB=/absolute/path/context-forge.db npm start
```

## Connect from Codex

Build the project first, then register its STDIO command:

```bash
codex mcp add context-forge \
  --env CONTEXT_FORGE_DB=/absolute/path/context-forge.db \
  -- node /absolute/path/to/context-forge/dist/index.js
```

Equivalent project-scoped `.codex/config.toml` configuration:

```toml
[mcp_servers.context-forge]
command = "node"
args = ["/absolute/path/to/context-forge/dist/index.js"]
cwd = "/absolute/path/to/context-forge"
env = { CONTEXT_FORGE_DB = "/absolute/path/context-forge.db" }
required = true
```

Restart the Codex client after changing MCP configuration. Use `/mcp` or `codex mcp list` to verify the connection.

## MCP tools

### `prepare_task`

The core orchestration tool. It gathers evidence and returns a readiness decision.

```json
{
  "taskId": "PAY-381",
  "elicitation": "auto"
}
```

When information is missing and elicitation is unavailable, the result remains machine-readable:

```json
{
  "status": "needs_clarification",
  "questions": [
    {
      "id": "scheduled-transfer-reservation",
      "question": "Should pending scheduled transfers reserve part of the daily limit?",
      "reason": "Neither Jira nor the active policy defines reservation behavior.",
      "impact": "This determines whether pending transfers reduce the remaining limit.",
      "options": ["yes", "no"],
      "required": true
    }
  ]
}
```

Pass known answers directly when a host cannot perform elicitation:

```json
{
  "taskId": "PAY-381",
  "answers": {
    "scheduled-transfer-reservation": "yes",
    "existing-customer-rollout": "immediately"
  }
}
```

### `search_context`

Searches active evidence with lexical matching, metadata filters, and relationship expansion.

```json
{
  "query": "TransferLimitService PRIORITY_CUSTOMER",
  "domain": "transfer",
  "product": "retail-banking",
  "limit": 10
}
```

### `resolve_unknown`

Persists one clarification answer and immediately re-evaluates task readiness.

### `task_status`

Returns the current readiness assessment without initiating elicitation.

### `ingest_context`

Upserts a structured bundle of documents and tasks. This is idempotent by document/task ID.

## Ingest data from JSON

```bash
npm run ingest -- ./examples/context-bundle.json
```

Important document fields:

- `source.type`, `source.id`, and `source.url` preserve provenance.
- `version`, `effectiveFrom`, `status`, and `supersedes` prevent stale policy from silently winning retrieval.
- `requirements[].kind` distinguishes verified facts from inferences.
- `unknowns[]` contains structured questions with reason, impact, options, and requiredness.
- `relationships[]` connects evidence that keyword search alone may miss.

## Development

```bash
npm run check
npm test
npm run build
```

Tests cover version filtering, relationship expansion, readiness transitions, conflict detection, MCP fallback behavior, and end-to-end MCP elicitation.

## Current boundary

ContextForge does not generate business requirements from prose and then promote them to facts. The MVP expects connectors or ingestion pipelines to supply structured requirements and uncertainties. A future analyzer may propose inferred requirements, but the `kind` and source fields must remain explicit.
