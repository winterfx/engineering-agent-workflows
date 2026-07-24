# engineering-agent-workflows

Versioned AI workflows for software engineering automation. The first workflow, `issue-triage`, processes GitHub Issues without cloning the target repository.

## Issue triage workflow

The workflow:

1. receives a GitHub `issues` webhook envelope;
2. loads the full Issue and existing bot comment;
3. searches the repository for candidate duplicate or related Issues;
4. calls `runtime.llm()` with a strict Zod output schema;
5. calculates the final priority with deterministic policy code;
6. normalizes the title and merges labels in managed namespaces;
7. creates or updates one triage comment containing GitHub `#issue` cross-references.

The first version never closes Issues and never clones the target repository. It defaults to dry-run.

## Repository layout

```text
agents/issue-triage/     Agent instructions, prompt, manifest, and policy
loaders/github-issue.js  Thin agent-compose Scheduler trigger
src/github/              GitHub REST API boundary
src/issue-triage/        Deterministic workflow and Runtime SDK integration
examples/                Webhook fixtures
test/                    Network-free unit tests
```

The project definition is [`agent-compose.yml`](./agent-compose.yml). Copy
`.env.example` to `.env` before validation or apply. Daemon-side queue settings
are provided separately in `deploy/daemon.env.example`; project `env_file`
values do not configure the daemon process.

## Requirements

- Node.js 20 or newer
- an agent-compose guest runtime with `@chaitin-ai/agent-compose-runtime-sdk` support
- GitHub token or GitHub App installation token

Recommended GitHub App repository permissions:

- Metadata: read
- Issues: read and write

Subscribe the App or webhook adapter to the GitHub `Issues` event. Deliver its JSON body to the agent-compose topic `webhook.github.issues`.

## Configuration

| Variable                           | Required                               | Purpose                                                   |
| ---------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| `GITHUB_TOKEN`                     | For private repositories or apply mode | GitHub API authentication                                 |
| `GITHUB_API_URL`                   | No                                     | GitHub API base; defaults to `https://api.github.com`     |
| `ISSUE_TRIAGE_MODEL`               | No                                     | Model override for `runtime.llm()`                        |
| `ISSUE_TRIAGE_APPLY`               | No                                     | Set to `1` to enable GitHub writes; defaults to dry-run   |
| `ISSUE_TRIAGE_BOT_LOGIN`           | Recommended                            | Ignores Issue events emitted by this bot account          |
| `ENGINEERING_AGENT_WORKFLOWS_REPO` | Loader only                            | Clone URL for this repository                             |
| `ENGINEERING_AGENT_WORKFLOWS_REF`  | Loader only                            | Pinned branch, tag, or release branch; defaults to `main` |
| `ISSUE_TRIAGE_GUEST_IMAGE`         | Loader only                            | Optional guest image override                             |

Model/provider credentials remain owned by agent-compose and are not stored in this repository.

## Local verification

```bash
npm install
npm run check
```

Running the real workflow requires a reachable agent-compose LLM service and GitHub API:

```bash
GITHUB_TOKEN=... \
ISSUE_TRIAGE_MODEL=gpt-5.4 \
npm start -- \
  --workflow issue-triage \
  --event examples/github-issue-opened.json \
  --dry-run
```

Add `--apply` only after reviewing dry-run behavior and creating a scoped GitHub credential.

## Deploying the Loader

1. Push this repository to a URL reachable from the guest image.
2. Copy `.env.example` to `.env` and configure its values, preferably pinning `ENGINEERING_AGENT_WORKFLOWS_REF` to a reviewed tag.
3. Keep `ISSUE_TRIAGE_APPLY=0` initially.
4. Add the variables from `deploy/daemon.env.example` to the agent-compose daemon environment and restart the daemon.
5. Run `agent-compose config --quiet`, then `agent-compose up` from this repository.
6. Deliver GitHub Issues webhook bodies to `/api/webhooks/webhook.github.issues` through an authenticated webhook source or adapter.
7. Inspect dry-run results, then set `ISSUE_TRIAGE_APPLY=1` and run `agent-compose up` again.

GitHub has no native general-purpose Issue link API. References such as `#123` in the managed triage comment create GitHub cross-reference events and preserve the relationship without rewriting the Issue body.

## Priority policy

The model extracts facts; code chooses the priority:

- `P0`: explicit critical security impact, data loss, or production outage
- `P1`: high security impact, release blocker, or blocked production core flow without a workaround
- `P2`: explicit broad/degraded impact, SLA risk, or blocked core flow
- `P3`: supported low-impact work
- `pending`: insufficient evidence or low confidence

Edit `agents/issue-triage/policy.json` to tune thresholds and managed labels. Keep destructive operations outside this workflow.
