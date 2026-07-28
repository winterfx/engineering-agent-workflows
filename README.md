# engineering-agent-workflows

Versioned AI engineering workflows with thin event ingestion, deterministic
policy, and explicit Git/provider boundaries.

## Workflows

### Issue triage

Supports GitHub Issues. The Agent classifies the Issue and suggests
facts; deterministic code calculates priority, checks duplicate candidates, and
updates managed labels plus one managed comment.

Triage preserves the Issue title and human-owned labels. It never adds
`agent:ready` or manages `area:*`. Add `skip-triage` to opt out.

### Draft PR implementation

A maintainer adds `agent:ready` to authorize work on an open Issue in the exact
allowlisted GitHub repository:

```text
agent:ready ──▶ agent:running ──┬──▶ agent:pr-open
                               ├──▶ agent:needs-approval
                               └──▶ agent:failed

agent:needs-approval + agent:approved ──▶ agent:running
```

The Agent edits and tests an isolated checkout without provider credentials.
The trusted outer tool validates the Issue context, repository state, diff,
tests, secrets, and policy gates before it creates a commit, pushes
`codex/issue-<number>`, and opens a Draft PR.

The workflow never merges, marks a PR ready, closes an Issue, or force-pushes.

### Pull Request fixes

An Agent-managed PR has two automatic fix paths:

| Event                                                | Starts Agent | Behavior                                           |
| ---------------------------------------------------- | ------------ | -------------------------------------------------- |
| `pull_request_review` with `changes_requested`       | Yes          | Fixes one trusted Review as a batch                |
| `pull_request_review` with `approved` or `commented` | No           | Ignored                                            |
| `pull_request_review_comment`                        | No           | A standalone inline comment never starts the Agent |
| Ordinary PR `issue_comment`                          | No           | Ignored by the Draft PR workflow                   |
| Failed `check_suite.completed`                       | Yes          | Fixes failed checks from that suite as a batch     |

For a requested-change Review:

- the reviewer must be a repository `OWNER`, `MEMBER`, or `COLLABORATOR`;
- the Review body and non-reply inline comments from the same Review ID are one
  batch, including the single-inline-comment case;
- the Review must target the current PR head and an open Agent-managed Draft PR;
- one batch produces at most one commit and one non-force push.

For CI, the tool refetches failed checks and annotations, verifies the current
head and suite, and applies the same diff and risk gates before pushing.

Review content and CI output are untrusted. The Agent must verify findings
against code and cannot reply to or resolve Review threads. Policy limits bound
automatic attempts and batch size; oversized or sensitive work pauses for a
maintainer. There is no recurring reconciliation timer.

## Trust boundary

- Scheduler loaders only parse events and start deterministic tools.
- Provider state is refetched before preparation and before any write.
- The Agent receives a writable checkout but no GitHub credentials.
- The Agent leaves changes uncommitted; trusted code inspects, commits, and
  pushes them.
- Per-Issue and per-PR locks prevent concurrent writes to the same target.
- Fingerprints and head SHAs reject stale Agent results.
- User-authored content and labels are preserved unless a documented managed
  namespace permits replacement.

Dry-run mode may clone and evaluate a local diff, but it does not change labels,
comments, branches, or Pull Requests.

## Managed labels

Issue triage may add a type label (`bug`, `enhancement`, `documentation`, or
`question`) when one is not already present. Only `priority:*` and `triage:*`
are replaceable namespaces. Human-owned labels, including `agent:*`, `area:*`,
`good first issue`, and `help wanted`, are preserved.

Draft PR state uses `agent:ready`, `agent:approved`, `agent:running`,
`agent:pr-open`, `agent:needs-approval`, and `agent:failed`.

Policies and label metadata live in:

- `agents/issue-triage/policy.json`
- `agents/draft-pr/policy.json`

## Repository layout

```text
agents/       Skills, policy, schemas, and generated tool bundles
loaders/      Thin agent-compose Scheduler scripts
src/          Deterministic orchestration and provider/Git boundaries
test/         Network-free observable behavior tests
examples/     Webhook fixtures
deploy/       Daemon environment examples
```

Do not edit `agents/*/scripts/*.mjs` directly. Change `src/` and run
`npm run build`. Loader files are snapshotted by `agent-compose config/up`, so
reload the configuration after changing them.

## Setup

Requirements:

- Node.js 20 or newer
- agent-compose with skills, event schedulers, and bind volumes
- `./.draft-pr-workspaces` writable by the daemon and Agent sandbox

GitHub permissions:

- Metadata: read
- Issues: read and write
- Contents: read and write for Draft PRs
- Pull requests: read and write for Draft PRs
- Checks: read for CI fixes

GitHub webhook events:

- Issues and Issue comments
- Pull request reviews
- Check suites

Map them to `webhook.github.issues`, `webhook.github.issue_comment`,
`webhook.github.pull_request_review`, and `webhook.github.check_suite`.
Pull Request review-comment events are not required.

GitHub deliveries enter through the agent-compose Webhook API. Configure the
agent-compose deployment to authenticate the GitHub Webhook source, verify
provider signatures, and publish each event to the topic listed above. This
repository does not run a separate Webhook ingress or relay.

## Configuration

Copy `.env.example` to `.env`. The main settings are:

- provider credential: `GITHUB_TOKEN`;
- bot identity: `GITHUB_BOT_LOGIN`;
- apply switches: `ISSUE_TRIAGE_APPLY`, `DRAFT_PR_APPLY`;
- Draft PR allowlist: `DRAFT_PR_ALLOWED_REPOSITORY`;
- optional model, API URL, Git author, and workspace settings documented in
  `.env.example` and `agent-compose.yml`.

Webhook source credentials and public ingress configuration belong to the
agent-compose deployment rather than this project's `.env`.

Keep apply mode disabled until dry-run output has been reviewed.

## Verify and run

```bash
npm ci
npm run build
npm run check
agent-compose config --quiet
agent-compose up
```

After changing `src/`, tests must pass and generated bundles must be rebuilt.
Behavior changes require deterministic tests without public network or model
calls.

For deployment, also copy the required values from
`deploy/daemon.env.example`, configure authenticated webhook sources, and test
with fixtures under `examples/` before enabling apply mode.
