import { readFile } from "node:fs/promises";
import { errorMessage } from "./errors.js";

export async function loadJsonFromCandidates<T>(
  candidates: string[],
  parse: (value: unknown) => T,
  failureMessage: string,
): Promise<T> {
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return parse(JSON.parse(await readFile(candidate, "utf8")) as unknown);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${failureMessage}: ${errorMessage(lastError)}`);
}
