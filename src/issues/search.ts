export function issueSearchText(title: string): string {
  return title
    .replace(/^\[[^\]]+\]\s*:?\s*/, "")
    .replace(/["'`:+(){}[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
