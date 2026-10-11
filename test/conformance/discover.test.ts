/**
 * `new GnarlClient()` with no url reaches the node on this machine through the
 * endpoint.json it records. The record is written here by hand, pointing at the
 * conformance node, so the test does not depend on the node writing it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GnarlClient } from "../../src/index.js";
import { nodeUrl, noNode } from "./harness.js";
import { fetchFor } from "./node.js";

describe.skipIf(noNode)("discovery of the local node", () => {
  let scratch: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "gnarl-discover-conf-"));
    const u = new URL(nodeUrl);
    mkdirSync(join(scratch, "data", "runtime"), { recursive: true });
    mkdirSync(join(scratch, "home"));
    writeFileSync(
      join(scratch, "data", "runtime", "endpoint.json"),
      JSON.stringify({ scheme: u.protocol.replace(":", ""), host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port), pid: 1 }),
    );
    vi.stubEnv("GNARL_URL", "");
    vi.stubEnv("LUCENIA_DATA_DIR", join(scratch, "data"));
    vi.stubEnv("HOME", join(scratch, "home"));
    vi.stubEnv("USERPROFILE", join(scratch, "home"));
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("new GnarlClient() with no url reaches the node the endpoint file names", async () => {
    // Only the certificate is relaxed (for a self-signed harness node); the
    // address comes from discovery alone.
    const c = new GnarlClient({ fetch: fetchFor(nodeUrl), timeoutMs: 10_000 });
    expect(new URL(c.url).port).toBe(new URL(nodeUrl).port);
    await c.ping();
  });
});
