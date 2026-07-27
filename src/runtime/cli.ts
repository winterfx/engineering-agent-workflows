export function requiredArgumentValue(
  args: string[],
  index: number,
  name: string,
): string {
  const value = args[index]?.trim();
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

export function envBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function isPositiveInteger(value: string | undefined): boolean {
  const number = Number(value?.trim());
  return Number.isSafeInteger(number) && number > 0;
}
