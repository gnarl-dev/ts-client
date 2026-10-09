/**
 * Behaviour beyond "sends the right request": pagination, completeness,
 * existence checks, helpers, argument validation.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chunk,
  documentBody,
  failedItems,
  GnarlClient,
  GnarlError,
  IncompleteResultError,
  NotFoundError,
  ndjsonPair,
  toNdjson,
  VERSION,
} from "../../src/index.js";
import { mockFetch, reply } from "./mock.js";

const client = (fetch: ReturnType<typeof mockFetch>["fetch"]) => new GnarlClient({ url: "https://n.test", fetch });
const hit = (id: string, sort: unknown[]) => ({ _id: id, _score: null, _source: { id }, sort });
const page = (hits: unknown[], partial = false, served = 2) => ({
  hits: { total: { value: hits.length, relation: "gte" }, hits },
  took: 1,
  partial,
  coverage: { expected_claims: 2, served_claims: served, skipped_claims: served < 2 ? [{ claim_id: 1, reason: "timeout" }] : [] },
});

describe("listIndexes", () => {
  it("follows next_after until it is absent, including past a short page", async () => {
    const m = mockFetch(
      reply({ indexes: [{ name: "a" }, { name: "b" }], next_after: "b" }),
      reply({ indexes: [], next_after: "c" }), // short (system indexes hidden) but not last
      reply({ indexes: [{ name: "d" }] }),
    );
    const names: string[] = [];
    for await (const idx of client(m.fetch).listIndexes({ limit: 2 })) names.push(idx.name);
    expect(names).toEqual(["a", "b", "d"]);
    expect(m.calls.map((c) => c.query)).toEqual([{ limit: "2" }, { limit: "2", after: "b" }, { limit: "2", after: "c" }]);
  });

  it("stops rather than loops when a cursor does not advance", async () => {
    const m = mockFetch(reply({ indexes: [{ name: "a" }], next_after: "a" }), reply({ indexes: [{ name: "a" }], next_after: "a" }));
    const it = client(m.fetch).listIndexes();
    await expect(
      (async () => {
        for await (const _ of it) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/did not advance/);
  });
});

describe("namespaces.list", () => {
  it("follows the cursor too", async () => {
    const m = mockFetch(reply({ namespaces: [{ name: "a" }], next_after: "a" }), reply({ namespaces: [{ name: "b" }] }));
    const names: string[] = [];
    for await (const ns of client(m.fetch).namespaces.list()) names.push(ns.name);
    expect(names).toEqual(["a", "b"]);
  });
});

describe("searchAfter", () => {
  it("walks pages using the last hit's sort values and stops on an empty page", async () => {
    const m = mockFetch(reply(page([hit("a", [1, "a"]), hit("b", [2, "b"])])), reply(page([hit("c", [3, "c"])])), reply(page([])));
    const ids: string[] = [];
    for await (const h of client(m.fetch).searchAfter("i", { sort: [{ n: { order: "asc" } }], size: 2 })) ids.push(h._id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(m.calls.map((c) => (c.body as { search_after?: unknown }).search_after)).toEqual([undefined, [2, "b"], [3, "c"]]);
  });

  it("starts from a caller-supplied cursor", async () => {
    const m = mockFetch(reply(page([])));
    for await (const _ of client(m.fetch).searchAfter("i", { sort: ["n"], search_after: [9, "z"] })) {
      /* none */
    }
    expect(m.calls[0]?.body).toMatchObject({ search_after: [9, "z"] });
  });

  it("refuses a request without sort, before any request", async () => {
    const m = mockFetch(reply(page([])));
    await expect(client(m.fetch).searchAfter("i", {}).next()).rejects.toThrow(/explicit `sort`/);
    expect(m.calls).toHaveLength(0);
  });

  it("reports a hit with no sort values instead of looping", async () => {
    const m = mockFetch(reply(page([{ _id: "a" }])));
    const it = client(m.fetch).searchAfter("i", { sort: ["n"] });
    await it.next();
    await expect(it.next()).rejects.toThrow(/no `sort` values/);
  });

  it("reports a cursor that does not advance instead of looping", async () => {
    const m = mockFetch(reply(page([hit("a", [1, "a"])])));
    const it = client(m.fetch).searchAfter("i", { sort: ["n"] });
    await it.next();
    await it.next();
    await expect(it.next()).rejects.toThrow(/did not advance/);
  });
});

describe("requireComplete", () => {
  it("passes a complete response through", async () => {
    const m = mockFetch(reply(page([hit("a", [1])])));
    const res = await client(m.fetch).search("i", {}, { requireComplete: true });
    expect(res.hits.hits).toHaveLength(1);
  });

  it("throws on partial, carrying the partial response", async () => {
    const m = mockFetch(reply(page([hit("a", [1])], true, 1)));
    const err = await client(m.fetch)
      .search("i", {}, { requireComplete: true })
      .catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteResultError);
    expect(err.response.hits.hits[0]._id).toBe("a");
    expect(err.reason).toBe("1 of 2 claims answered, 1 skipped (requireComplete was set)");
  });

  it("throws when a claim went unserved even if `partial` was not set", async () => {
    const m = mockFetch(reply(page([], false, 1)));
    await expect(client(m.fetch).namespaces.search("ns", {}, { requireComplete: true })).rejects.toBeInstanceOf(IncompleteResultError);
  });

  it("does nothing when not asked", async () => {
    const m = mockFetch(reply(page([], true, 1)));
    expect((await client(m.fetch).search("i")).partial).toBe(true);
  });
});

describe("indexExists", () => {
  it("is false only for index_not_found", async () => {
    const m = mockFetch({ status: 404, json: { error: { type: "index_not_found", reason: "no" } } });
    expect(await client(m.fetch).indexExists("x")).toBe(false);
  });

  it("throws any other 404 rather than guessing", async () => {
    const route = mockFetch({ status: 404, json: { error: { type: "route_not_found", reason: "no route" } } });
    await expect(client(route.fetch).indexExists("x")).rejects.toBeInstanceOf(NotFoundError);
    const bodyless = mockFetch({ status: 404, text: "" });
    await expect(client(bodyless.fetch).indexExists("x")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("snapshots.waitForJob", () => {
  it("polls until the job leaves running, and returns a failed job rather than throwing", async () => {
    const m = mockFetch(
      reply({ id: "j", state: "running" }),
      reply({ id: "j", state: "running" }),
      reply({ id: "j", state: "failed", error: "disk" }),
    );
    const job = await client(m.fetch).snapshots.waitForJob("j", { intervalMs: 1 });
    expect(job.state).toBe("failed");
    expect(m.calls).toHaveLength(3);
  });

  it("gives up at its deadline", async () => {
    const m = mockFetch(reply({ id: "j", state: "running" }));
    await expect(client(m.fetch).snapshots.waitForJob("j", { intervalMs: 5, deadlineMs: 12 })).rejects.toThrow(/still running/);
  });

  it("stops polling when aborted", async () => {
    const m = mockFetch(reply({ id: "j", state: "running" }));
    const ac = new AbortController();
    const p = client(m.fetch).snapshots.waitForJob("j", { intervalMs: 1000, signal: ac.signal });
    setTimeout(() => ac.abort(new Error("stop")), 10);
    await expect(p).rejects.toThrow("stop");
  });
});

describe("argument validation happens before any request", () => {
  const m = mockFetch(reply({}));
  const c = client(m.fetch);
  it.each([
    ["an empty index name", () => c.getIndex("")],
    ["an empty document id", () => c.getDocument("i", "")],
    ["an empty explicit id", () => c.indexDocument("i", {}, { id: "" })],
    ["a non-object document", () => c.indexDocument("i", [] as never)],
    ["an empty bulk", () => c.bulk("i", [])],
    ["a non-object bulk document", () => c.bulk("i", [{ a: 1 }, null as never])],
    ["a schema without fields", () => c.createIndex("i", {} as never)],
    ["an empty activation key", () => c.activate("  ")],
    ["a relative escape-hatch path", () => c.request("GET", "v1/x")],
  ])("rejects %s", (_what, call) => {
    let thrown: unknown;
    try {
      void call();
    } catch (e) {
      thrown = e;
    }
    // Thrown synchronously, as a programming error — not a rejected request.
    expect(thrown instanceof TypeError || thrown instanceof RangeError).toBe(true);
    expect(m.calls).toHaveLength(0);
  });

  it("names the failing bulk position", () => {
    expect(() => c.bulk("i", [{ a: 1 }, "x" as never])).toThrow(/document 1/);
  });
});

describe("helpers", () => {
  it("failedItems finds per-item failures in either bulk shape", () => {
    const res = {
      errors: true,
      ack: "accepted" as const,
      items: [
        { _id: "a", status: 201 },
        { _id: "b", status: 400, error: { type: "validation_error" as const, reason: "bad" } },
      ],
    };
    expect(failedItems(res).map((i) => i._id)).toEqual(["b"]);
    expect(failedItems({ took: 1, errors: true, ack: "x", items: [{ seq: 0, status: 400 }] })).toHaveLength(1);
    expect(failedItems({ errors: false, ack: "accepted", items: [{ _id: "a", status: 201 }] })).toEqual([]);
  });

  it("documentBody puts _id at the top level and copies", () => {
    const doc = { a: 1 };
    const out = documentBody(doc, "x");
    expect(out).toEqual({ a: 1, _id: "x" });
    expect(doc).toEqual({ a: 1 });
  });

  it("chunk groups sync and async iterables", async () => {
    const out: number[][] = [];
    for await (const b of chunk([1, 2, 3, 4, 5], 2)) out.push(b);
    expect(out).toEqual([[1, 2], [3, 4], [5]]);
    async function* gen() {
      yield 1;
      yield 2;
    }
    const out2: number[][] = [];
    for await (const b of chunk(gen(), 5)) out2.push(b);
    expect(out2).toEqual([[1, 2]]);
    await expect(chunk([1], 0).next()).rejects.toThrow(RangeError);
  });

  it("ndjsonPair moves _id to the action line", () => {
    expect(ndjsonPair({ _id: "a", x: 1 })).toBe('{"index":{"_id":"a"}}\n{"x":1}\n');
    expect(ndjsonPair({ x: 1 })).toBe('{"index":{}}\n{"x":1}\n');
    expect(() => ndjsonPair({ _id: 5 })).toThrow(TypeError);
  });

  it("toNdjson encodes lazily from an async source", async () => {
    let pulled = 0;
    async function* gen() {
      for (let i = 0; i < 3; i++) {
        pulled++;
        yield { _id: String(i) };
      }
    }
    const stream = toNdjson(gen());
    expect(pulled).toBe(0);
    const text = await new Response(stream).text();
    expect(text.trim().split("\n")).toHaveLength(6);
    expect(pulled).toBe(3);
  });

  it("bulkStream passes a caller's NDJSON stream through untouched", async () => {
    const m = mockFetch(reply({ took: 0, items: [], errors: false, ack: "accepted" }));
    const raw = '{"index":{}}\n{"a":1}\n';
    await client(m.fetch).bulkStream(
      "i",
      new ReadableStream({
        start(ctl) {
          ctl.enqueue(new TextEncoder().encode(raw));
          ctl.close();
        },
      }),
    );
    expect(m.calls[0]?.bodyText).toBe(raw);
  });
});

describe("package metadata", () => {
  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });

  it("has no runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it("GnarlError subclasses survive a JSON round trip of their fields", () => {
    const e = new GnarlError({ type: "x", reason: "y", status: 400 });
    expect({ type: e.type, reason: e.reason, status: e.status }).toEqual({ type: "x", reason: "y", status: 400 });
  });
});
