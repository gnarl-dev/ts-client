/**
 * Starting and stopping a REAL node.
 *
 * Compiling proves the types match the description. It does not prove the
 * description matches the server, and that gap is where client bugs live — so
 * this boots the actual binary and drives it over real HTTP.
 *
 * The node runs with TLS, the PRODUCT DEFAULT: `start` serves https on the
 * chosen port from a self-signed certificate. A harness that passed `--no-tls`
 * would test a configuration most readers never run.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";
import { GnarlClient } from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where a node binary comes from, in order: `$LUCENIA_BIN` / `$GNARL_BIN`
 * (the public release names it `gnarl`), then the sibling lucenia checkout's
 * release or debug build, whichever is newer.
 */
export function candidateBinaries(): string[] {
  const explicit = process.env.LUCENIA_BIN || process.env.GNARL_BIN;
  if (explicit) return [explicit];
  const sibling = resolve(here, "../../../lucenia/rust/target");
  // Newest first: a stale release build beside a fresh debug one would test
  // yesterday's server.
  return [join(sibling, "release/lucenia"), join(sibling, "debug/lucenia")]
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? ok(addr.port) : fail(new Error("no port"))));
    });
  });
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * A fetch that accepts the node's self-signed certificate — ONLY for a
 * loopback address. Pointing `$GNARL_TEST_NODE` at a real deployment still
 * verifies its certificate rather than silently accepting anyone's. This is
 * the same recipe the README gives.
 */
export function fetchFor(url: string) {
  const host = new URL(url).hostname;
  if (!LOOPBACK.has(host) || url.startsWith("http:")) return undefined;
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  return (input: string, init?: Parameters<typeof undiciFetch>[1]) => undiciFetch(input, { ...init, dispatcher });
}

export function clientFor(url: string, extra: ConstructorParameters<typeof GnarlClient>[0] = {}): GnarlClient {
  return new GnarlClient({ url, fetch: fetchFor(url), timeoutMs: 60_000, ...extra });
}

export async function waitReady(url: string, withinMs: number): Promise<string | undefined> {
  const probe = clientFor(url, { timeoutMs: 2000, retry: false });
  const deadline = Date.now() + withinMs;
  let last = "never tried";
  // Poll rather than sleep a guessed interval: a fixed sleep passes on a
  // laptop and fails on a loaded runner, where it reads as a product defect.
  while (Date.now() < deadline) {
    try {
      await probe.ping();
      return undefined;
    } catch (err) {
      last = String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return `after ${withinMs} ms: ${last}`;
}

export interface RunningNode {
  url: string;
  proc: ChildProcess;
  dataDir: string;
  logPath: string;
  stop(): Promise<void>;
}

/** Start a single-node mesh on a free port and wait until it answers. */
export async function startNode(binary: string, extraArgs: string[] = []): Promise<RunningNode> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "gnarl-ts-conformance-"));
  const logPath = join(dataDir, "node.log");
  // The log goes to a FILE: a pipe nobody reads fills up and blocks the node.
  const log = openSync(logPath, "w");
  const proc = spawn(
    binary,
    [
      "start",
      "--port",
      String(port),
      "--data-dir",
      dataDir,
      // Off any real mesh: a conformance run must not discover a developer's
      // cluster, join it, and assert on data it does not own.
      "--single-node",
      "--headless",
      ...extraArgs,
    ],
    { stdio: ["ignore", log, log] },
  );
  const url = `https://127.0.0.1:${port}`;

  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((r) => proc.once("exit", () => r()));
      proc.kill("SIGTERM");
      const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }
    rmSync(dataDir, { recursive: true, force: true });
  };

  const exitedEarly = new Promise<string>((r) => proc.once("exit", (code, sig) => r(`node exited early (code ${code}, signal ${sig})`)));
  const problem = await Promise.race([waitReady(url, 90_000), exitedEarly]);
  if (problem) {
    const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-3000) : "";
    await stop();
    throw new Error(`node at ${url} never became ready: ${problem}\n${tail}`);
  }
  return { url, proc, dataDir, logPath, stop };
}
