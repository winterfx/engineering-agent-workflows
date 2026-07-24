# Repository Guidelines

This repository owns versioned AI engineering workflows. Keep event ingestion thin, workflow decisions testable, and provider/network side effects behind explicit boundaries.

- `agents/` contains agent instructions, prompts, schemas, and policy configuration.
- `src/` contains deterministic orchestration and boundary adapters.
- `loaders/` contains minimal agent-compose Scheduler trigger scripts.
- `test/` covers observable workflow behavior without public network or model calls.

AI output is advisory input. Validate it before performing GitHub writes. Preserve user-authored content and labels unless a documented managed namespace explicitly permits replacement. Never commit credentials or log tokens, webhook secrets, authorization headers, or unfiltered environment values.

Use Node.js 20 or newer, TypeScript strict mode, Prettier, and Vitest. A behavior change requires focused deterministic tests. Run `npm run check` before handoff.
