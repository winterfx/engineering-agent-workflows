export function repositoryCloneUrl(
  serverUrl: string,
  repository: string,
): string {
  const base = new URL(serverUrl);
  if (base.protocol !== "https:") {
    throw new Error("GitHub server URL must use HTTPS");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/${repository}.git`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export function sanitizeTitle(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function assertAllowedRepository(
  repository: string,
  allowed: string,
): void {
  if (!allowed.trim()) {
    throw new Error("Draft PR repository allowlist is required");
  }
  if (repository.trim().toLowerCase() !== allowed.trim().toLowerCase()) {
    throw new Error("repository is outside the Draft PR allowlist");
  }
}
