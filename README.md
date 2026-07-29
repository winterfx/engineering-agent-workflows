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

- Scheduler source modules only parse events and start deterministic tools.
- Each generated Scheduler artifact embeds its deterministic Node tool and
  materializes it only inside a fresh shell sandbox.
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
agents/       Skills, policy, and generated self-contained Scheduler artifacts
src/          Scheduler sources plus deterministic provider/Git boundaries
test/         Network-free observable behavior tests
examples/     Webhook fixtures
deploy/       Daemon environment examples
```

Do not edit `agents/*/scheduler.js` directly. Change `src/` and run
`npm run build`. Each Agent is built into one versioned Scheduler JavaScript
artifact. The artifact contains the thin event loader and an embedded Node.js
tool bundle; provider credentials remain available only to the deterministic
shell process, while Agent sandboxes explicitly clear them. Scheduler files are
snapshotted by `agent-compose config/up`, so reload the configuration after
changing them.

## Setup

Requirements:

- Node.js 20 or newer
- agent-compose with skills, event schedulers, and bind volumes
- `./.draft-pr-workspaces` writable by the daemon and Agent sandbox
- the published `ghcr.io/winterfx/agent-compose-guest-dev:main` Draft PR
  development image, containing Go, `buf`, Task, `golangci-lint`, `nilaway`,
  and `ripgrep`

Before each Agent run, the Scheduler performs a credential-free workspace
preparation step. Repositories containing `buf.gen.yaml` run `buf generate` in
the prepared checkout so package tests see protobuf and Connect Go sources that
are intentionally not committed. A preparation failure is recorded before the
Agent starts.

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

- provider credential: a legacy static `GITHUB_TOKEN`, or GitHub App
  `GITHUB_APP_CLIENT_ID` (preferred) / `GITHUB_APP_ID` plus
  `GITHUB_APP_PRIVATE_KEY_BASE64`;
- bot identity: `GITHUB_BOT_LOGIN`;
- apply switches: `ISSUE_TRIAGE_APPLY`, `DRAFT_PR_APPLY`;
- Draft PR allowlist: `DRAFT_PR_ALLOWED_REPOSITORY`;
- Draft PR commit identity: `DRAFT_PR_GIT_AUTHOR_NAME` and
  `DRAFT_PR_GIT_AUTHOR_EMAIL`;
- optional model settings documented in `.env.example` and
  `agent-compose.yml`.

Webhook source credentials and public ingress configuration belong to the
agent-compose deployment rather than this project's `.env`.

Keep apply mode disabled until dry-run output has been reviewed.

For GitHub App authentication, install the App on the allowlisted repository
with the permissions above. Encode its PEM private key without line breaks:

```bash
openssl base64 -A -in github-app.private-key.pem
```

Store the result as `GITHUB_APP_PRIVATE_KEY_BASE64` and set
`GITHUB_BOT_LOGIN` to the App slug followed by `[bot]`. The workflow signs a
short-lived App JWT, discovers the installation from the target repository,
and exchanges it for an installation access token on every trusted tool
invocation. `GITHUB_APP_INSTALLATION_ID` may be set to skip discovery. A
non-empty `GITHUB_TOKEN` takes precedence for backwards compatibility. App
private keys remain available only to trusted deterministic tools and are
cleared from Agent sandboxes.

## Verify and run

Generated Scheduler artifacts are versioned, so a clean checkout verifies them
without rewriting them:

```bash
npm ci
npm run check
agent-compose config --quiet
agent-compose up
```

GitHub Actions runs `npm ci` and `npm run check` for every Pull Request and push
to `main`. CI verifies that generated Scheduler artifacts match their source;
it does not regenerate or commit them. Run `npm run build` locally and include
the updated `agents/*/scheduler.js` files in the Pull Request.

The build and runtime use two different JavaScript environments. Node.js runs
`scripts/build-tools.ts` and esbuild locally or in CI. The resulting Scheduler
file is JavaScript source loaded by the agent-compose QuickJS runtime; it is not
QuickJS bytecode. QuickJS handles event registration and orchestration only.
The embedded provider/Git tool is restored inside `scheduler.shell(...)` and
executed there by Node.js 20, so Node-specific modules never run inside QuickJS.

After changing `src/`, run `npm run build` before `npm run check`.
Behavior changes require deterministic tests without public network or model
calls.

For deployment, also copy the required values from
`deploy/daemon.env.example`, configure authenticated webhook sources, and test
with fixtures under `examples/` before enabling apply mode.
