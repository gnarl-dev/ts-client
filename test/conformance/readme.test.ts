/**
 * Every runnable `ts` example in README.md, executed in order against the
 * live node. A snippet that does not work is a failing test, not a bug report.
 *
 * Snippets build `new GnarlClient()`, which reads `$GNARL_URL`; the node is
 * self-signed, so the global fetch is swapped for one that accepts its
 * certificate (loopback only) — the quick start shows readers the same thing.
 */

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error — a plain .mjs helper shared with the type-check script.
import { readmeSnippets, writeSnippets } from "../../scripts/readme-snippets.mjs";
import { nodeBinary, nodeUrl, noNode } from "./harness.js";
import { fetchFor } from "./node.js";

const root = resolve(__dirname, "../..");
const outDir = join(root, "build/readme-snippets-run");

// The examples create fixed names ("places"), so they run only against a node
// this harness started fresh — never against a node someone already uses.
describe.skipIf(noNode || nodeBinary === "")("README examples", () => {
  const files: string[] = writeSnippets(outDir);
  const snippets: { line: number }[] = readmeSnippets();

  beforeAll(() => {
    vi.stubEnv("GNARL_URL", nodeUrl);
    vi.stubEnv("GNARL_TOKEN", "");
    const insecure = fetchFor(nodeUrl);
    if (insecure) vi.stubGlobal("fetch", insecure);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("found the examples", () => {
    expect(files.length).toBe(snippets.length);
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  files.forEach((file, i) => {
    it(`README.md line ${snippets[i]?.line}`, async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await import(pathToFileURL(file).href);
      } finally {
        log.mockRestore();
      }
    });
  });
});
