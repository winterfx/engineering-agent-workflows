import { isRepositorySlug } from "../issues/types.js";

export interface BoundTargetOptions {
  repository: string;
  targetNumber: number;
  apply: boolean;
  expectedRepository: string | undefined;
  expectedTarget: string | undefined;
  errors: {
    missing: string;
    incomplete: string;
    invalid: string;
    mismatch: (expectedRepository: string, expectedTarget: number) => string;
  };
}

export function assertBoundTarget(options: BoundTargetOptions): void {
  const expectedRepository = options.expectedRepository?.trim() ?? "";
  const expectedTargetText = options.expectedTarget?.trim() ?? "";

  if (!expectedRepository && !expectedTargetText) {
    if (options.apply) throw new Error(options.errors.missing);
    return;
  }
  if (!expectedRepository || !expectedTargetText) {
    throw new Error(options.errors.incomplete);
  }

  const expectedTarget = Number(expectedTargetText);
  if (
    !isRepositorySlug(expectedRepository) ||
    !Number.isSafeInteger(expectedTarget) ||
    expectedTarget <= 0
  ) {
    throw new Error(options.errors.invalid);
  }
  if (
    options.repository !== expectedRepository ||
    options.targetNumber !== expectedTarget
  ) {
    throw new Error(
      options.errors.mismatch(expectedRepository, expectedTarget),
    );
  }
}
