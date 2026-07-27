export function truncateText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
