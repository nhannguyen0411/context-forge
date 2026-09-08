#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { databasePath } from "../config.js";
import { contextBundleSchema } from "../domain.js";
import { ContextDatabase } from "../storage.js";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: context-forge-ingest <bundle.json>");
  process.exitCode = 1;
} else {
  const json = JSON.parse(await readFile(resolve(inputPath), "utf8")) as unknown;
  const bundle = contextBundleSchema.parse(json);
  const database = new ContextDatabase(databasePath());
  try {
    const result = database.importBundle(bundle);
    console.log(
      `Ingested ${result.documents} document(s) and ${result.tasks} task(s) into ${databasePath()}`,
    );
  } finally {
    database.close();
  }
}
