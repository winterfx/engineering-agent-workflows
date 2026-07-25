# engineering-agent-workflows

Versioned AI workflows for software engineering automation. The first workflow, `issue-triage`, processes GitHub Issues without cloning the target repository.

## Issue triage workflow

The workflow:

1. receives a GitHub `issues` or `issue_comment` webhook envelope;
2. invokes the configured agent with the `issue-triage` Skill;
3. uses the bundled tool to load the current Issue, ordinary comments, and candidate Issues;
4. asks the agent for structured advisory analysis;
5. validates that analysis and calculates priority with deterministic code;
6. preserves unmanaged labels and rejects stale Issue content;
7. creates or updates one managed triage comment.

The Scheduler keeps GitHub credentials and the trusted Issue target outside the
agent call. The agent receives prepared context with `GITHUB_TOKEN` removed and
returns analysis JSON only; deterministic Scheduler-side tool calls perform any
GitHub writes.

The first version never closes Issues and never clones the target repository. It defaults to dry-run.

## Repository layout

```text
agents/issue-triage/     Agent Skill, policy, and bundled deterministic tool
src/github/              GitHub REST API boundary
src/issue-triage/        Deterministic validation and policy source
examples/                Webhook fixtures
test/                    Network-free unit tests
```

`agent-compose.yml` contains the trusted `scheduler.on(...)` event adapter. It
runs target-bound preparation, passes the prepared context to
`scheduler.agent(...)`, and applies validated output; no repository clone or
per-event dependency installation is performed. Do not edit the generated
`agents/issue-triage/scripts/issue-triage.mjs` bundle directly—run
`npm run build` after changing `src/`.

The project definition is [`agent-compose.yml`](./agent-compose.yml). Copy
`.env.example` to `.env` before validation or apply. Daemon-side queue settings
are provided separately in `deploy/daemon.env.example`; project `env_file`
values do not configure the daemon process.

## Requirements

- Node.js 20 or newer
- an agent-compose version that supports YAML `skills` and event schedulers
- GitHub token or GitHub App installation token

Recommended GitHub App repository permissions:

- Metadata: read
- Issues: read and write

Subscribe the App or webhook adapter to the GitHub `Issues` and `Issue comment`
events. Deliver their JSON bodies to the agent-compose topics
`webhook.github.issues` and `webhook.github.issue_comment`, respectively.

## Configuration

| Variable                 | Required                               | Purpose                                                 |
| ------------------------ | -------------------------------------- | ------------------------------------------------------- |
| `GITHUB_TOKEN`           | For private repositories or apply mode | GitHub API authentication                               |
| `GITHUB_API_URL`         | No                                     | GitHub API base; defaults to `https://api.github.com`   |
| `ISSUE_TRIAGE_MODEL`     | No                                     | Agent model override                                    |
| `ISSUE_TRIAGE_APPLY`     | No                                     | Set to `1` to enable GitHub writes; defaults to dry-run |
| `ISSUE_TRIAGE_BOT_LOGIN` | Required in apply mode                 | Owns the managed comment and prevents bot event loops   |

Model/provider credentials remain owned by agent-compose and are not stored in this repository.

## Local verification

```bash
npm install
npm run build
npm run check
agent-compose config --quiet
```

The bundled tool can be exercised against GitHub independently of the agent:

```bash
GITHUB_TOKEN=... \
npm start -- prepare --repository owner/repository --issue 123
```

The `apply` command accepts an agent analysis file and remains dry-run unless
`ISSUE_TRIAGE_APPLY=1` is present in the environment. Apply mode also requires
`ISSUE_TRIAGE_BOT_LOGIN` and a trusted target binding. For a reviewed manual
application, set `ISSUE_TRIAGE_EXPECTED_REPOSITORY` and
`ISSUE_TRIAGE_EXPECTED_ISSUE` to the same target passed on the command line.

## Deploying the workflow

1. Run `npm ci && npm run build` from a reviewed revision.
2. Copy `.env.example` to `.env`, configure it, and keep `ISSUE_TRIAGE_APPLY=0` initially.
3. Add the variables from `deploy/daemon.env.example` to the agent-compose daemon environment and restart the daemon.
4. Run `agent-compose config --quiet`, then `agent-compose up` from this repository. The local Skill is resolved and projected into the Agent sandbox.
5. Deliver GitHub Issues webhook bodies to `/api/webhooks/webhook.github.issues` through an authenticated webhook source or adapter.
6. Inspect dry-run results, then set `ISSUE_TRIAGE_APPLY=1` and run `agent-compose up` again.

GitHub has no native general-purpose Issue link API. References such as `#123` in the managed triage comment create GitHub cross-reference events and preserve the relationship without rewriting the Issue body.

## Priority policy

The model extracts facts; code chooses the priority:

- `P0`: explicit critical security impact, data loss, or production outage
- `P1`: high security impact, release blocker, or blocked production core flow without a workaround
- `P2`: explicit broad/degraded impact, SLA risk, or blocked core flow
- `P3`: supported low-impact work
- `pending`: insufficient evidence or low confidence

Edit `agents/issue-triage/policy.json` to tune thresholds and managed labels. Keep destructive operations outside this workflow.
