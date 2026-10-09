import { createHash } from "node:crypto";
import { afterAll, inject } from "vitest";
import type { GnarlClient, IndexSchema } from "../../src/index.js";
import { clientFor } from "./node.js";

export const nodeUrl = inject("nodeUrl");
export const nodeBinary = inject("nodeBinary");
/** True when there is no node; every conformance `describe` skips on it. */
export const noNode = nodeUrl === "";

export function client(): GnarlClient {
  return clientFor(nodeUrl);
}

let seq = 0;

/**
 * A name unique to this run and call. The node caps names at 64 characters
 * and requires `^[a-z0-9][a-z0-9_-]*$`.
 */
export function uniqueName(prefix: string): string {
  const salt = createHash("sha256").update(`${process.pid}-${Date.now()}-${seq++}-${Math.random()}`).digest("hex").slice(0, 10);
  return `${prefix}-${salt}`.toLowerCase().slice(0, 64);
}

/** Create an index that is deleted when the file's tests finish. */
export async function tempIndex(c: GnarlClient, schema: IndexSchema, prefix = "conf"): Promise<string> {
  const name = uniqueName(prefix);
  await c.createIndex(name, schema);
  afterAll(async () => {
    // Cleanup failing must not mask the test's own verdict.
    await c.deleteIndex(name).catch(() => undefined);
  });
  return name;
}

/**
 * Poll until `predicate` holds. Proves PRESENCE only: an early `true` means it
 * arrived; proving absence would mean spending the whole window.
 */
export async function until(predicate: () => Promise<boolean>, withinMs = 30_000, everyMs = 100): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}
