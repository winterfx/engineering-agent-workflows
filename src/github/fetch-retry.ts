const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);

export interface FetchRetryOptions {
  request: typeof fetch;
  input: string;
  init: RequestInit;
  operation: string;
  retryable: boolean;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function fetchWithRetry(
  options: FetchRetryOptions,
): Promise<Response> {
  const attempts = options.retryable ? MAX_ATTEMPTS : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await options.request(options.input, options.init);
      if (
        attempt === attempts ||
        !RETRYABLE_STATUS_CODES.has(response.status)
      ) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        throw new Error(
          `${options.operation} transport failed after ${attemptLabel(attempts)}`,
          { cause: error },
        );
      }
    }
    await (options.sleep ?? sleep)(retryDelayMilliseconds(attempt));
  }
  throw new Error(`${options.operation} transport failed`, {
    cause: lastError,
  });
}

function attemptLabel(attempts: number): string {
  return `${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
}

function retryDelayMilliseconds(attempt: number): number {
  const exponential = 250 * 2 ** (attempt - 1);
  return exponential + Math.floor(Math.random() * exponential);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
