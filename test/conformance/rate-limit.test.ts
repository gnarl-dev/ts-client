/**
 * Retry against the node's REAL rate limiter, on a second node started with a
 * tiny budget. The main node runs with the limiter off; this is the one place
 * a 429 and its Retry-After come from the server rather than a test double.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GnarlError, RateLimitedError } from "../../src/index.js";
import { nodeBinary, noNode } from "./harness.js";
import { clientFor, type RunningNode, startNode } from "./node.js";

describe.skipIf(noNode || nodeBinary === "")("rate limiting", () => {
  let node: RunningNode;
  beforeAll(async () => {
    // 60/min refills one token a second; a burst of 3 trips on the 4th call.
    node = await startNode(nodeBinary, ["--http-rate-limit", "60", "--http-rate-limit-burst", "3"]);
  });
  afterAll(async () => {
    await node?.stop();
  });

  it("answers 429 rate_limited with a Retry-After the client surfaces", async () => {
    const c = clientFor(node.url, { retry: false });
    let err: GnarlError | undefined;
    for (let i = 0; i < 20 && !err; i++) {
      err = (await c.listIndexesPage().then(
        () => undefined,
        (e) => e,
      )) as GnarlError | undefined;
    }
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err?.status).toBe(429);
    expect(err?.type).toBe("rate_limited");
    expect(err?.retryAfter).toBeGreaterThanOrEqual(0);
    expect(err?.retryAfter).toBeLessThanOrEqual(60);
  });

  it("the default retry policy rides through the limiter", async () => {
    const c = clientFor(node.url);
    const started = Date.now();
    for (let i = 0; i < 8; i++) await c.listIndexesPage();
    // Eight calls against a burst of three at one token a second cannot all
    // be immediate: the client must have waited as told.
    expect(Date.now() - started).toBeGreaterThan(1500);
  });
});
