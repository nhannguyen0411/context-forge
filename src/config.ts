import { resolve } from "node:path";

export function databasePath(): string {
  return resolve(
    process.env.CONTEXT_FORGE_DB ??
      resolve(process.cwd(), ".context-forge", "context-forge.db"),
  );
}
