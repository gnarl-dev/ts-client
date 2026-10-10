// Extracts the runnable TypeScript examples from README.md.
//
// A ```ts fence is runnable unless the line before it is a
// `<!-- doctest: skip because … -->` comment. Used by the doc tests (which RUN
// the snippets against a live node) and by `npm run typecheck:readme` (which
// type-checks them against the real declarations).
//
//   node scripts/readme-snippets.mjs <outDir>   writes NN.ts files, prints count

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function readmeSnippets(path = join(root, "README.md")) {
  const lines = readFileSync(path, "utf8").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "```ts") continue;
    const skip = i > 0 && /^<!-- doctest: skip because .+ -->$/.test(lines[i - 1]);
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end] !== "```") end++;
    if (end === lines.length) throw new Error(`README.md:${i + 1}: unterminated fence`);
    if (!skip) out.push({ line: i + 1, code: lines.slice(start, end).join("\n") });
    i = end;
  }
  return out;
}

/** Write each snippet as a module importing the package from source. */
export function writeSnippets(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const entry = relative(outDir, join(root, "src/index.js")).replaceAll("\\", "/");
  const files = [];
  for (const [n, s] of readmeSnippets().entries()) {
    const file = join(outDir, `${String(n).padStart(2, "0")}-line${s.line}.ts`);
    const code = s.code.replaceAll('from "gnarl-client"', `from "${entry.startsWith(".") ? entry : `./${entry}`}"`);
    // `export {}` makes every snippet a module, so top-level await and
    // same-named consts in different snippets are both fine.
    writeFileSync(file, `// README.md line ${s.line}\n${code}\nexport {};\n`);
    files.push(file);
  }
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] ?? join(root, "build/readme-snippets"));
  console.log(`${writeSnippets(outDir).length} README snippets -> ${relative(root, outDir)}`);
}
