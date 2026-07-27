import { readFile, writeFile } from "node:fs/promises";

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error("at least one generated file path is required");
}

for (const file of files) {
  const source = await readFile(file, "utf8");
  await writeFile(file, source.replace(/[ \t]+$/gm, ""));
}
