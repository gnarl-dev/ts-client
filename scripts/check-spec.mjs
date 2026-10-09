// Fails unless spec/openapi.yaml is byte-for-byte the server's description.
//
// The regeneration check proves the generated types match the VENDORED
// description; this proves the vendored description is the CURRENT one. A
// client can be perfectly self-consistent and perfectly stale.
//
//   node scripts/check-spec.mjs <path-or-url>
//   GNARL_UPSTREAM_SPEC=<path-or-url> node scripts/check-spec.mjs
//
// With no upstream given it looks for a sibling lucenia checkout.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendoredPath = join(root, "spec/openapi.yaml");
const sibling = resolve(root, "../lucenia/rust/api/openapi.yaml");
const source = process.argv[2] ?? process.env.GNARL_UPSTREAM_SPEC ?? (existsSync(sibling) ? sibling : undefined);

if (!source) {
  console.error("check-spec: no upstream description. Pass a path or URL, or set GNARL_UPSTREAM_SPEC.");
  process.exit(2);
}

const upstream = /^https?:\/\//.test(source)
  ? Buffer.from(
      await fetch(source).then((r) => {
        if (!r.ok) throw new Error(`check-spec: ${source}: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
    )
  : readFileSync(source);
const vendored = readFileSync(vendoredPath);
const sha = (b) => createHash("sha256").update(b).digest("hex");

if (Buffer.compare(upstream, vendored) !== 0) {
  console.error(`check-spec: spec/openapi.yaml (${sha(vendored).slice(0, 12)}) is not ${source} (${sha(upstream).slice(0, 12)}).`);
  console.error("Re-vendor it byte-for-byte, then `npm run generate` and commit both.");
  process.exit(1);
}
console.log(`check-spec: spec/openapi.yaml matches ${source} (sha256 ${sha(vendored).slice(0, 12)})`);
