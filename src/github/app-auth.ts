import { sign } from "node:crypto";

const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export interface GitHubTokenDependencies {
  fetch?: typeof fetch;
  now?: () => number;
}

interface GitHubInstallationAPI {
  id?: number;
}

interface GitHubInstallationTokenAPI {
  token?: string;
}

export async function resolveGitHubToken(
  repository: string,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: GitHubTokenDependencies = {},
): Promise<string> {
  const configuredToken = env.GITHUB_TOKEN?.trim() ?? "";
  if (configuredToken) return configuredToken;

  const clientID = env.GITHUB_APP_CLIENT_ID?.trim() ?? "";
  const appID = env.GITHUB_APP_ID?.trim() ?? "";
  const privateKeyBase64 = env.GITHUB_APP_PRIVATE_KEY_BASE64?.trim() ?? "";
  const configuredInstallationID = env.GITHUB_APP_INSTALLATION_ID?.trim() ?? "";
  const hasAppConfiguration = Boolean(
    clientID || appID || privateKeyBase64 || configuredInstallationID,
  );
  if (!hasAppConfiguration) return "";

  const issuer = clientID || appID;
  if (!issuer) {
    throw new Error(
      "GitHub App authentication requires GITHUB_APP_CLIENT_ID or GITHUB_APP_ID",
    );
  }
  if (!privateKeyBase64) {
    throw new Error(
      "GitHub App authentication requires GITHUB_APP_PRIVATE_KEY_BASE64",
    );
  }

  const privateKey = decodePrivateKey(privateKeyBase64);
  const jwt = createAppJWT(
    issuer,
    privateKey,
    dependencies.now?.() ?? Date.now(),
  );
  const baseUrl = (
    env.GITHUB_API_URL?.trim() || DEFAULT_GITHUB_API_URL
  ).replace(/\/+$/, "");
  const request = dependencies.fetch ?? fetch;
  const installationID = configuredInstallationID
    ? validateInstallationID(configuredInstallationID)
    : await findInstallationID(baseUrl, repository, jwt, request);

  const response = await request(
    `${baseUrl}/app/installations/${installationID}/access_tokens`,
    {
      method: "POST",
      headers: appHeaders(jwt),
    },
  );
  if (!response.ok) {
    throw githubAppResponseError("installation token request", response);
  }
  const value = (await response.json()) as GitHubInstallationTokenAPI;
  const token = value.token?.trim() ?? "";
  if (!token) {
    throw new Error("GitHub App installation token response has no token");
  }
  return token;
}

function createAppJWT(
  issuer: string,
  privateKey: string,
  nowMilliseconds: number,
): string {
  const now = Math.floor(nowMilliseconds / 1000);
  const header = encodeJWTPart({ alg: "RS256", typ: "JWT" });
  const payload = encodeJWTPart({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: issuer,
  });
  const unsignedToken = `${header}.${payload}`;
  let signature: Buffer;
  try {
    signature = sign("RSA-SHA256", Buffer.from(unsignedToken), privateKey);
  } catch {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY_BASE64 is not a valid RSA private key",
    );
  }
  return `${unsignedToken}.${signature.toString("base64url")}`;
}

async function findInstallationID(
  baseUrl: string,
  repository: string,
  jwt: string,
  request: typeof fetch,
): Promise<string> {
  const response = await request(
    `${baseUrl}/repos/${repositoryPath(repository)}/installation`,
    {
      method: "GET",
      headers: appHeaders(jwt),
    },
  );
  if (!response.ok) {
    throw githubAppResponseError("installation lookup", response);
  }
  const value = (await response.json()) as GitHubInstallationAPI;
  if (!Number.isSafeInteger(value.id) || (value.id ?? 0) <= 0) {
    throw new Error("GitHub App installation response has no valid ID");
  }
  return String(value.id);
}

function appHeaders(jwt: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${jwt}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "engineering-agent-workflows/github-app-auth",
  };
}

function decodePrivateKey(value: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8").trim();
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY_BASE64 is not valid base64");
  }
  if (!/^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(decoded)) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY_BASE64 must decode to a PEM private key",
    );
  }
  return decoded;
}

function validateInstallationID(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("GITHUB_APP_INSTALLATION_ID must be a positive integer");
  }
  return value;
}

function repositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part.trim())) {
    throw new Error(`invalid GitHub repository: ${repository}`);
  }
  return parts.map(encodeURIComponent).join("/");
}

function encodeJWTPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function githubAppResponseError(operation: string, response: Response): Error {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  return new Error(`GitHub App ${operation} failed with ${status}`);
}
