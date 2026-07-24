const EVENT_TOPIC = "webhook.github.issues";
const TRIGGER_ID = "engineering-agent-workflows-issue-triage-v1";
const RESULT_PREFIX = "__ENGINEERING_AGENT_WORKFLOW_RESULT__";

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function requireEnv(name) {
  const value = firstText(process.env[name]);
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function base64EncodeUTF8(value) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = [];
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      }
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }

  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    output += alphabet[a >> 2];
    output += alphabet[((a & 3) << 4) | (b >> 4)];
    output +=
      index + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : "=";
    output += index + 2 < bytes.length ? alphabet[c & 63] : "=";
  }
  return output;
}

function parseResult(output) {
  const lines = String(output || "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith(RESULT_PREFIX)) continue;
    try {
      return JSON.parse(line.slice(RESULT_PREFIX.length));
    } catch {
      return null;
    }
  }
  return null;
}

function handleGitHubIssue(event) {
  const repositoryURL = requireEnv("ENGINEERING_AGENT_WORKFLOWS_REPO");
  const repositoryRef = firstText(
    process.env.ENGINEERING_AGENT_WORKFLOWS_REF,
    "main",
  );
  const githubToken = requireEnv("GITHUB_TOKEN");
  const script = [
    "set -eu",
    'WORKFLOW_DIR="/workspace/engineering-agent-workflows"',
    'ASKPASS="/tmp/engineering-agent-workflows-askpass.sh"',
    "cat > \"$ASKPASS\" <<'SH'",
    "#!/bin/sh",
    'case "$1" in',
    '  *Username*) printf "%s\\n" "x-access-token" ;;',
    '  *Password*) printf "%s\\n" "$GITHUB_TOKEN" ;;',
    '  *) printf "\\n" ;;',
    "esac",
    "SH",
    'chmod 700 "$ASKPASS"',
    'GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 git clone --depth 1 --branch "$WORKFLOW_REF" "$WORKFLOW_REPO" "$WORKFLOW_DIR"',
    'cd "$WORKFLOW_DIR"',
    'printf "%s" "$ISSUE_EVENT_B64" | base64 -d > /tmp/github-issue-event.json',
    "npm ci --ignore-scripts --no-audit --no-fund",
    "npm start -- --workflow issue-triage --event /tmp/github-issue-event.json",
  ].join("\n");

  const shellOptions = {
    title: "github-issue-triage",
    sessionPolicy: "new",
    env: {
      WORKFLOW_REPO: repositoryURL,
      WORKFLOW_REF: repositoryRef,
      ISSUE_EVENT_B64: base64EncodeUTF8(JSON.stringify(event)),
      ISSUE_TRIAGE_APPLY: firstText(process.env.ISSUE_TRIAGE_APPLY, "0"),
      ISSUE_TRIAGE_MODEL: firstText(process.env.ISSUE_TRIAGE_MODEL),
      ISSUE_TRIAGE_BOT_LOGIN: firstText(process.env.ISSUE_TRIAGE_BOT_LOGIN),
      GITHUB_API_URL: firstText(process.env.GITHUB_API_URL),
    },
    sandboxEnv: {
      GITHUB_TOKEN: { value: githubToken, secret: true },
    },
    timeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 2 * 1024 * 1024,
  };
  const guestImage = firstText(process.env.ISSUE_TRIAGE_GUEST_IMAGE);
  if (guestImage) shellOptions.guestImage = guestImage;
  const run = scheduler.shell(script, shellOptions);
  const result = parseResult(run.output || run.stdout);
  if (!run.success || !result || !result.ok) {
    throw new Error(
      "issue triage workflow failed: " +
        JSON.stringify({
          exitCode: run.exitCode,
          result,
          outputTail: String(
            run.output || run.stdout || run.stderr || "",
          ).slice(-4000),
        }),
    );
  }
  return result;
}

function main(payload) {
  return {
    ok: true,
    message: `POST /api/webhooks/${EVENT_TOPIC} with a GitHub issues webhook payload`,
    payload: payload || null,
  };
}

scheduler.on(EVENT_TOPIC, TRIGGER_ID, handleGitHubIssue);
