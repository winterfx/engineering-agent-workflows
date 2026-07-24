# Task

Analyze the current GitHub issue using the supplied policy and candidate issues.

Return only the structured output requested by the schema. Base every conclusion on explicit evidence from the issue or candidates. The host application will independently calculate the final priority and validate all proposed GitHub writes.

For the title, preserve established technical terms and identifiers. Use a bracketed area prefix such as `[API]`, `[CLI]`, `[Runtime]`, `[Reliability]`, `[Docs]`, or `[General]` without a colon after the bracket.

Acceptance criteria must describe observable outcomes. Missing information should be phrased as concise questions that an issue author can answer.
