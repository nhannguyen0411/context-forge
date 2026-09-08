#!/usr/bin/env node
import { databasePath } from "../config.js";
import { demoBundle } from "../demo.js";
import { ContextDatabase } from "../storage.js";

const database = new ContextDatabase(databasePath());
try {
  const result = database.importBundle(demoBundle);
  console.log(
    `Seeded ${result.documents} document(s) and ${result.tasks} task(s) into ${databasePath()}`,
  );
} finally {
  database.close();
}
