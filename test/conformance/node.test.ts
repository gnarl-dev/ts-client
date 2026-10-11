/**
 * Node introspection and the subscription surface, against a real node.
 */

import { describe, expect, it } from "vitest";
import { ConnectionError, GnarlClient, type GnarlError, NotFoundError, ValidationError } from "../../src/index.js";
import { client, nodeUrl, noNode } from "./harness.js";

describe.skipIf(noNode)("node", () => {
  const c = client();

  it("ping resolves", async () => {
    await expect(c.ping()).resolves.toBeUndefined();
  });

  it("version names a version", async () => {
    const v = await c.version();
    expect(typeof v.version).toBe("string");
    expect(v.version).not.toBe("");
  });

  it("status reports identity and the required members", async () => {
    const s = await c.status();
    expect(s.node_id).toMatch(/^[0-9a-f]{64}$/);
    expect(["private", "public", "lan", "dev-mesh", "single-node"]).toContain(s.mode);
    for (const k of ["peers", "reachable_peers", "claims", "serving_ready", "proof_verified"] as const) {
      expect(typeof s[k]).toBe("number");
    }
    expect(typeof s.load.saturated).toBe("boolean");
    expect(typeof s.connectivity).toBe("object");
    expect(typeof s.admission).toBe("object");
    expect(typeof s.storage).toBe("object");
  });

  it("the read-only node endpoints answer with objects", async () => {
    // updatesCheck is left out on purpose: it may reach the internet.
    const [stats, egress, peers, explain, mesh, contribution] = await Promise.all([
      c.node.stats(),
      c.node.egress(),
      c.node.peers(),
      c.node.explain(),
      c.node.mesh(),
      c.node.contribution(),
    ]);
    for (const body of [stats, explain, mesh, contribution]) expect(body).toBeTypeOf("object");
    expect(typeof egress.total_bytes).toBe("number");
    expect(Array.isArray(peers.peers)).toBe(true);
  });

  it("discover answers for a meshed node and is absent on a single-node one", async () => {
    const status = await c.status();
    if (status.mode === "single-node") {
      // Deliberate on the server (a SingleNode scope advertises nothing), but
      // undocumented, and the 404 carries no error envelope.
      const err = (await c.node.discover().catch((e) => e)) as GnarlError;
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.status).toBe(404);
    } else {
      expect((await c.node.discover()).node_id).toBe(status.node_id);
    }
  });
});

describe.skipIf(noNode)("entitlement", () => {
  const c = client();

  it("reports the three-state status with its required members", async () => {
    const e = await c.entitlement();
    expect(typeof e.active).toBe("boolean");
    expect(typeof e.enforced).toBe("boolean");
    expect(Array.isArray(e.features)).toBe(true);
    // refused/not_after are present-or-null, never another shape.
    expect(e.refused === undefined || e.refused === null || typeof e.refused === "string").toBe(true);
    expect(e.not_after === undefined || e.not_after === null || Number.isInteger(e.not_after)).toBe(true);
    if (e.active) expect(e.refused ?? null).toBeNull();
  });

  it("refuses a malformed activation key with a reason, and stores nothing", async () => {
    const before = await c.entitlement();
    const err = (await c.activate("gnarl-ent1.not-a-real-key").catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
    expect(err.reason).not.toBe("");
    expect(await c.entitlement()).toEqual(before);
  });
});

describe.skipIf(noNode)("connection failures", () => {
  it("a closed port is a ConnectionError with status 0, not a hang", async () => {
    const dead = new GnarlClient({ url: "http://127.0.0.1:1", timeoutMs: 5000, retry: false });
    const err = (await dead.ping().catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.status).toBe(0);
    expect(err.type).toBe("connection_error");
  });

  it.skipIf(nodeUrl.startsWith("http:"))("https with the default fetch refuses the self-signed certificate", async () => {
    // The protection is on unless the caller turns it off for one node.
    const strict = new GnarlClient({ url: nodeUrl, timeoutMs: 5000, retry: false });
    const err = (await strict.ping().catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toMatch(/certificate|self.signed|SELF_SIGNED|UNABLE_TO_VERIFY/i);
  });
});
