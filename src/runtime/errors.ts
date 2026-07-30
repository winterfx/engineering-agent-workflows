export function errorMessage(error: unknown): string {
  return describeError(error, new Set(), 0);
}

function describeError(
  error: unknown,
  seen: Set<unknown>,
  depth: number,
): string {
  if (!(error instanceof Error)) return String(error);
  seen.add(error);
  const code = errorCode(error);
  const description =
    depth === 0
      ? error.message
      : `${error.name}${code ? ` [${code}]` : ""}: ${error.message}`;
  if (depth >= 4 || error.cause === undefined || seen.has(error.cause)) {
    return description;
  }
  return `${description}; cause: ${describeError(error.cause, seen, depth + 1)}`;
}

function errorCode(error: Error): string {
  if (!("code" in error)) return "";
  const value = error.code;
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}
