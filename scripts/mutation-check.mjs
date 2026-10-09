// Verifies the verifier: for every public method, break it and confirm the
// unit suite notices.
//
// Three mutations per client method, each applied alone to src/client.ts:
//   noop  — the method returns immediately and sends nothing
//   route — the first `/v1/` path the method builds gains a stray segment
//   verb  — the first HTTP verb the method uses becomes a different one
// plus `noop` for each exported helper in src/helpers.ts. A mutation the
// suite still passes is a SURVIVOR: a method whose test would not catch it
// being broken. Exits non-zero on any survivor. Sources are restored after.
//
//   node scripts/mutation-check.mjs            # all
//   node scripts/mutation-check.mjs search     # methods whose name matches

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filter = process.argv[2];

/** Every method body in `src`: { name, open (index of `{`), close (index of matching `}`), generator }. */
function methods(src, { indent, pattern }) {
  const out = [];
  const re = new RegExp(pattern, "gm");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const name = m.groups.name;
    if (["constructor", "if", "for", "while", "switch", "catch"].includes(name)) continue;
    // The body opens at the first `{` that ends a line at this indent level.
    const open = src.indexOf(`{\n`, m.index);
    let depth = 0;
    let close = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        close = i;
        break;
      }
    }
    out.push({ name, open, close, generator: /\*\s*$/.test(m.groups.prefix ?? "") || /async \*/.test(m[0]), indent });
  }
  return out;
}

function classOf(src, index) {
  const before = src.slice(0, index);
  const m = [...before.matchAll(/^export class (\w+)/gm)].pop();
  return m ? m[1] : "";
}

function runUnit() {
  const r = spawnSync("npx", ["vitest", "run", "--project", "unit", "--reporter=dot"], { cwd: root, encoding: "utf8" });
  return r.status === 0;
}

const targets = [];
const clientPath = join(root, "src/client.ts");
const clientSrc = readFileSync(clientPath, "utf8");
for (const m of methods(clientSrc, { pattern: "^  (?<prefix>async \\*|async |\\*)?(?<name>[a-zA-Z]\\w*)(<[^>]*>)?\\(" })) {
  const cls = classOf(clientSrc, m.open);
  const label = `${cls}.${m.name}`;
  const body = clientSrc.slice(m.open, m.close);
  const noop = m.generator ? "{\n    return;\n" : "{\n    return undefined as never;\n";
  targets.push({ file: clientPath, src: clientSrc, label, kind: "noop", apply: (s) => s.slice(0, m.open) + noop + s.slice(m.open + 2) });
  const route = body.indexOf("/v1/");
  if (route >= 0) {
    targets.push({
      file: clientPath,
      src: clientSrc,
      label,
      kind: "route",
      apply: (s) => s.slice(0, m.open + route) + "/v1/x/" + s.slice(m.open + route + 4),
    });
  }
  const verb = body.match(/"(GET|POST|PUT|DELETE)"/);
  if (verb) {
    const swap = { GET: "POST", POST: "PUT", PUT: "POST", DELETE: "GET" }[verb[1]];
    const at = m.open + verb.index;
    targets.push({
      file: clientPath,
      src: clientSrc,
      label,
      kind: "verb",
      apply: (s) => `${s.slice(0, at)}"${swap}"${s.slice(at + verb[0].length)}`,
    });
  }
}

const helpersPath = join(root, "src/helpers.ts");
const helpersSrc = readFileSync(helpersPath, "utf8");
for (const m of methods(helpersSrc, {
  pattern: "^export (?<prefix>async function\\*|function\\*|async function|function) (?<name>\\w+)(<[^>]*>)?\\([^)]*\\)[^{;]*\\{$",
})) {
  if (m.close < 0) continue;
  const noop = m.generator ? "{\n  return;\n" : "{\n  return undefined as never;\n";
  targets.push({
    file: helpersPath,
    src: helpersSrc,
    label: `helpers.${m.name}`,
    kind: "noop",
    apply: (s) => s.slice(0, m.open) + noop + s.slice(m.open + 2),
  });
}

const selected = targets.filter((t) => !filter || t.label.toLowerCase().includes(filter.toLowerCase()));
if (!runUnit()) {
  console.error("mutation-check: the unmutated suite fails; fix that first");
  process.exit(2);
}

const survivors = [];
let killed = 0;
try {
  for (const t of selected) {
    writeFileSync(t.file, t.apply(t.src));
    const passed = runUnit();
    writeFileSync(t.file, t.src);
    if (passed) survivors.push(`${t.label} [${t.kind}]`);
    else killed++;
    process.stdout.write(passed ? "S" : ".");
  }
} finally {
  writeFileSync(clientPath, clientSrc);
  writeFileSync(helpersPath, helpersSrc);
}
console.log(`\nmutation-check: ${killed}/${selected.length} mutants killed across ${new Set(selected.map((t) => t.label)).size} methods`);
if (survivors.length) {
  console.log(`survivors (a test that would NOT notice this method broken):\n  ${survivors.join("\n  ")}`);
  process.exit(1);
}
