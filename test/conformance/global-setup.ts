/**
 * Finds a node for the conformance suite, in this order:
 *
 * 1. `$GNARL_TEST_NODE` — a node you already run (e.g. http://127.0.0.1:PORT).
 * 2. `$LUCENIA_BIN` / `$GNARL_BIN` — a binary this starts and stops itself.
 * 3. the newer of the sibling lucenia checkout's `rust/target/{release,debug}/lucenia`.
 *
 * With none, every conformance test SKIPS — unless `$GNARL_REQUIRE_NODE` is
 * set, as CI sets it, because a green run that skipped everything proves
 * nothing.
 */

import { existsSync } from "node:fs";
import type { TestProject } from "vitest/node";
import { candidateBinaries, type RunningNode, startNode, waitReady } from "./node.js";

declare module "vitest" {
  export interface ProvidedContext {
    nodeUrl: string;
    nodeBinary: string;
  }
}

let node: RunningNode | undefined;

export async function setup(project: TestProject) {
  const existing = process.env.GNARL_TEST_NODE;
  if (existing) {
    const problem = await waitReady(existing, 10_000);
    if (problem) throw new Error(`$GNARL_TEST_NODE=${existing} did not answer: ${problem}`);
    project.provide("nodeUrl", existing);
    project.provide("nodeBinary", "");
    return;
  }

  const binary = candidateBinaries().find((p) => existsSync(p));
  if (!binary) {
    const how =
      "no node available. Point $GNARL_TEST_NODE at a running node, or set $LUCENIA_BIN to a node binary " +
      "(cargo build -p luceniad --bin lucenia).";
    if (process.env.GNARL_REQUIRE_NODE) throw new Error(how);
    console.warn(`conformance: ${how} Skipping.`);
    project.provide("nodeUrl", "");
    project.provide("nodeBinary", "");
    return;
  }

  // `start` enables the production rate limiter (600/min, burst 60). That is
  // an abuse brake for an open mesh; one client running a suite trips the
  // burst in seconds and every later test becomes a 429 that reads as a
  // product defect. The limiter gets its own node in rate-limit.test.ts.
  node = await startNode(binary, ["--no-http-rate-limit"]);
  console.log(`conformance: ${binary} serving at ${node.url}`);
  project.provide("nodeUrl", node.url);
  project.provide("nodeBinary", binary);
}

export async function teardown() {
  await node?.stop();
}
