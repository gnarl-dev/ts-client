/**
 * Every public method, against a recording fetch.
 *
 * Each row states the exact request a method must send — verb, path, query,
 * headers that matter, body — and what it must return. The last test
 * enumerates the client's methods by reflection and fails when one has no
 * row, so a method cannot be added without being pinned here.
 */

import { describe, expect, it } from "vitest";
import { GnarlClient } from "../../src/index.js";
import { type Call, mockFetch, type Reply, reply } from "./mock.js";

interface Row {
  /** `method` or `group.method`. */
  name: string;
  run: (c: GnarlClient) => Promise<unknown>;
  reply: Reply;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Expected resolved value; defaults to the reply's JSON. */
  result?: unknown;
  /** Extra assertions on the captured call. */
  check?: (call: Call) => void;
}

const schema = { fields: { name: { type: "text" as const }, rank: { type: "integer" as const } } };
const meta = { name: "places", schema, engine_binding: "native", claim_count: 4 };
const searchRes = {
  hits: { total: { value: 1, relation: "gte" }, hits: [{ _id: "a", _score: 1, _source: { name: "x" } }] },
  took: 1,
  partial: false,
  coverage: { expected_claims: 4, served_claims: 4, skipped_claims: [] },
};
const bulkRes = { items: [{ _id: "a", status: 201 }], errors: false, ack: "visible_for_search" };
const job = { id: "j1", kind: "snapshot", state: "running", repository: "r", snapshot: "s" };

describe("the engine is called native whatever the node calls it", () => {
  // A node released before the rename reports `tantivy`. Each method that
  // returns index metadata must translate it; this fails when one does not.
  type Meta = { engine_binding: string };
  const legacy = { ...meta, engine_binding: "tantivy" };
  const cases: [string, (c: GnarlClient) => Promise<unknown>, unknown, (r: unknown) => unknown][] = [
    ["createIndex", (c) => c.createIndex("places", schema), legacy, (r) => (r as Meta).engine_binding],
    ["getIndex", (c) => c.getIndex("places"), legacy, (r) => (r as Meta).engine_binding],
    ["listIndexesPage", (c) => c.listIndexesPage(), { indexes: [legacy] }, (r) => (r as { indexes: Meta[] }).indexes[0]?.engine_binding],
    [
      "memory.remember",
      (c) => c.memory.remember({ content: "x" }),
      { id: "m1", namespace: "default", user: "u", embedder: "e", engine_binding: "tantivy" },
      (r) => (r as Meta).engine_binding,
    ],
  ];
  for (const [name, run, body, pick] of cases) {
    it(name, async () => {
      const { fetch } = mockFetch(reply(body));
      const c = new GnarlClient({ url: "https://node.test:9200", fetch });
      expect(pick(await run(c))).toBe("native");
    });
  }
  it("leaves lucene alone", async () => {
    const { fetch } = mockFetch(reply({ ...meta, engine_binding: "lucene" }));
    const c = new GnarlClient({ url: "https://node.test:9200", fetch });
    expect((await c.getIndex("places")).engine_binding).toBe("lucene");
  });
});

describe("recall on a namespace nothing was written to", () => {
  // Nodes up to 0.1.0-rc29 omit `embedder` from the empty answer, though the
  // contract declares it required. The client fills it so the type holds.
  it("still carries an embedder string", async () => {
    const { fetch } = mockFetch(reply({ namespace: "never-written", count: 0, memories: [] }));
    const c = new GnarlClient({ url: "https://node.test:9200", fetch });
    const r = await c.memory.recall({ query: "anything", namespace: "never-written" });
    expect(r).toEqual({ namespace: "never-written", count: 0, memories: [], embedder: "" });
  });
  it("keeps the embedder a node reports", async () => {
    const { fetch } = mockFetch(reply({ namespace: "n", count: 0, memories: [], embedder: "local_minilm" }));
    const c = new GnarlClient({ url: "https://node.test:9200", fetch });
    expect((await c.memory.recall({ query: "q" })).embedder).toBe("local_minilm");
  });
});

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const rows: Row[] = [
  // ── node ──
  { name: "ping", run: (c) => c.ping(), reply: reply({ node_id: "n" }), method: "GET", path: "/v1/node/status", result: undefined },
  { name: "version", run: (c) => c.version(), reply: reply({ version: "0.1.0" }), method: "GET", path: "/v1/node/version" },
  { name: "status", run: (c) => c.status(), reply: reply({ node_id: "n", claims: 3 }), method: "GET", path: "/v1/node/status" },
  {
    name: "entitlement",
    run: (c) => c.entitlement(),
    reply: reply({ active: false, refused: null, features: [], enforced: false }),
    method: "GET",
    path: "/v1/node/entitlement",
  },
  {
    name: "activate",
    run: (c) => c.activate("  gnarl-ent1.abc  "),
    reply: reply({ tier: "personal" }),
    method: "POST",
    path: "/v1/node/entitlement/activate",
    body: { key: "gnarl-ent1.abc" },
  },
  { name: "node.stats", run: (c) => c.node.stats(), reply: reply({ q: 1 }), method: "GET", path: "/v1/node/stats" },
  { name: "node.egress", run: (c) => c.node.egress(), reply: reply({ total_bytes: 1 }), method: "GET", path: "/v1/node/egress" },
  { name: "node.peers", run: (c) => c.node.peers(), reply: reply({ peers: [] }), method: "GET", path: "/v1/node/peers" },
  { name: "node.explain", run: (c) => c.node.explain(), reply: reply({ why: 1 }), method: "GET", path: "/v1/node/explain" },
  { name: "node.mesh", run: (c) => c.node.mesh(), reply: reply({ scope: "x" }), method: "GET", path: "/v1/node/mesh" },
  { name: "node.contribution", run: (c) => c.node.contribution(), reply: reply({ c: 1 }), method: "GET", path: "/v1/node/contribution" },
  { name: "node.updatesCheck", run: (c) => c.node.updatesCheck(), reply: reply({ u: 1 }), method: "GET", path: "/v1/node/updates/check" },
  { name: "node.discover", run: (c) => c.node.discover(), reply: reply({ node_id: "n" }), method: "GET", path: "/v1/bootstrap/discover" },

  // ── indexes ──
  {
    name: "createIndex",
    run: (c) => c.createIndex("places", schema),
    reply: reply(meta, 201),
    method: "PUT",
    path: "/v1/indexes/places",
    body: { schema },
  },
  { name: "getIndex", run: (c) => c.getIndex("places"), reply: reply(meta), method: "GET", path: "/v1/indexes/places" },
  { name: "indexExists", run: (c) => c.indexExists("places"), reply: reply(meta), method: "GET", path: "/v1/indexes/places", result: true },
  {
    name: "deleteIndex",
    run: (c) => c.deleteIndex("places"),
    reply: { status: 200 },
    method: "DELETE",
    path: "/v1/indexes/places",
    result: undefined,
  },
  {
    name: "listIndexesPage",
    run: (c) => c.listIndexesPage({ limit: 2, after: "a" }),
    reply: reply({ indexes: [meta], next_after: "places" }),
    method: "GET",
    path: "/v1/indexes",
    query: { limit: "2", after: "a" },
  },
  {
    name: "listIndexes",
    run: (c) => collect(c.listIndexes({ limit: 5 })),
    reply: reply({ indexes: [meta] }),
    method: "GET",
    path: "/v1/indexes",
    query: { limit: "5" },
    result: [meta],
  },
  { name: "getSchema", run: (c) => c.getSchema("places"), reply: reply(schema), method: "GET", path: "/v1/indexes/places/_schema" },
  {
    name: "count",
    run: (c) => c.count("places"),
    reply: reply({ count: 7, partial: false }),
    method: "GET",
    path: "/v1/indexes/places/_count",
  },
  {
    name: "forcemerge",
    run: (c) => c.forcemerge("places", { maxNumSegments: 2 }),
    reply: reply({ segments: 4, partial: false }),
    method: "POST",
    path: "/v1/indexes/places/_forcemerge",
    query: { max_num_segments: "2" },
  },
  {
    name: "buildGraph",
    run: (c) => c.buildGraph("roads", { field: "edge", weightField: "w", order: "inertial", coordField: "loc" }),
    reply: reply({ nodes: 3, edges: 2, fill_in: false, partial: false }),
    method: "POST",
    path: "/v1/indexes/roads/_graph/build",
    query: { field: "edge", weight_field: "w", order: "inertial", coord_field: "loc" },
  },
  {
    name: "graphRoute",
    run: (c) => c.graphRoute("roads", { field: "edge", weightField: "w", from: 1, to: 9 }),
    reply: reply({ found: true, cost: 12 }),
    method: "GET",
    path: "/v1/indexes/roads/_route",
    query: { field: "edge", weight_field: "w", from: "1", to: "9" },
  },
  {
    name: "getPolicy",
    run: (c) => c.getPolicy("places"),
    reply: reply({ placement: "mesh" }),
    method: "GET",
    path: "/v1/indexes/places/_policy",
  },
  {
    name: "putPolicy",
    run: (c) => c.putPolicy("places", { placement: "local" }),
    reply: reply({ placement: "local" }),
    method: "PUT",
    path: "/v1/indexes/places/_policy",
    body: { placement: "local" },
  },

  // ── documents ──
  {
    name: "indexDocument",
    run: (c) => c.indexDocument("places", { name: "x" }, { id: "a/b", waitFor: "visible", waitForTimeoutMs: 500, idempotencyKey: "k1" }),
    reply: reply({ _id: "a/b", ack: "visible_for_search" }, 201),
    method: "POST",
    path: "/v1/indexes/places/_doc",
    query: { wait_for: "visible", wait_for_timeout_ms: "500" },
    body: { name: "x", _id: "a/b" },
    headers: { "idempotency-key": "k1", "content-type": "application/json" },
  },
  {
    name: "getDocument",
    run: (c) => c.getDocument("places", "a/b?#"),
    reply: reply({ _id: "a/b?#", _source: { name: "x" } }),
    method: "GET",
    path: "/v1/indexes/places/_doc/a%2Fb%3F%23",
  },
  {
    name: "deleteDocument",
    run: (c) => c.deleteDocument("places", "a"),
    reply: { status: 200 },
    method: "DELETE",
    path: "/v1/indexes/places/_doc/a",
    result: undefined,
  },
  {
    name: "bulk",
    run: (c) => c.bulk("places", [{ _id: "a", name: "x" }, { name: "y" }], { waitFor: "durable" }),
    reply: reply(bulkRes),
    method: "POST",
    path: "/v1/indexes/places/_bulk",
    query: { wait_for: "durable" },
    body: { documents: [{ _id: "a", name: "x" }, { name: "y" }] },
  },
  {
    name: "bulkChunked",
    run: (c) => collect(c.bulkChunked("places", [{ name: "a" }, { name: "b" }, { name: "c" }], { chunkSize: 2 })),
    reply: reply(bulkRes),
    method: "POST",
    path: "/v1/indexes/places/_bulk",
    // The LAST call is captured: the second chunk holds one document.
    body: { documents: [{ name: "c" }] },
    result: [
      { offset: 0, response: bulkRes },
      { offset: 2, response: bulkRes },
    ],
  },
  {
    name: "bulkStream",
    run: (c) => c.bulkStream("places", [{ _id: "a", name: "x" }, { name: "y" }], { waitFor: "durable" }),
    reply: reply({ took: 1, items: [], errors: false, ack: "accepted_durably" }),
    method: "POST",
    path: "/v1/indexes/places/_bulk_stream",
    query: { wait_for: "durable" },
    headers: { "content-type": "application/x-ndjson" },
    check: (call) => {
      expect(call.streamed).toBe(true);
      expect(call.bodyText).toBe('{"index":{"_id":"a"}}\n{"name":"x"}\n{"index":{}}\n{"name":"y"}\n');
    },
  },
  {
    name: "bulkProto",
    run: (c) => c.bulkProto("places", new Uint8Array([1, 2, 3]), { contentEncoding: "zstd", waitFor: "durable" }),
    reply: reply({ took: 1, items: [], errors: false, ack: "accepted_durably" }),
    method: "POST",
    path: "/v1/indexes/places/_bulk_proto",
    query: { wait_for: "durable" },
    headers: { "content-type": "application/x-protobuf", "content-encoding": "zstd" },
    check: (call) => expect(call.bodyText).toBe("\u0001\u0002\u0003"),
  },

  // ── search ──
  {
    name: "search",
    run: (c) => c.search("places", { query: { match: { name: "x" } }, size: 3 }),
    reply: reply(searchRes),
    method: "POST",
    path: "/v1/indexes/places/_search",
    body: { query: { match: { name: "x" } }, size: 3 },
  },
  {
    name: "searchAfter",
    run: (c) => collect(c.searchAfter("places", { sort: [{ rank: { order: "asc" } }], size: 1, from: 5 })),
    reply: reply({ ...searchRes, hits: { total: { value: 0, relation: "gte" }, hits: [] } }),
    method: "POST",
    path: "/v1/indexes/places/_search",
    // `from` is dropped: search_after ignores it and the first page has no cursor.
    body: { sort: [{ rank: { order: "asc" } }], size: 1 },
    result: [],
  },

  // ── memory ──
  {
    name: "memory.remember",
    run: (c) => c.memory.remember({ content: "likes tea", user: "u1", tags: { src: "chat" } }),
    reply: reply({ id: "m1", namespace: "default", user: "u1", embedder: "e" }),
    method: "POST",
    path: "/v1/memory/remember",
    body: { content: "likes tea", user: "u1", tags: { src: "chat" } },
  },
  {
    name: "memory.recall",
    run: (c) => c.memory.recall({ query: "tea", user: "u1", k: 3 }),
    reply: reply({ namespace: "default", count: 0, memories: [], embedder: "e" }),
    method: "POST",
    path: "/v1/memory/recall",
    body: { query: "tea", user: "u1", k: 3 },
  },
  {
    name: "memory.answer",
    run: (c) => c.memory.answer({ query: "tea?", user: "u1" }),
    reply: reply({ answer: "yes" }),
    method: "POST",
    path: "/v1/memory/answer",
    body: { query: "tea?", user: "u1" },
  },
  {
    name: "memory.bootstrap",
    run: (c) => c.memory.bootstrap(),
    reply: reply({ active: true }),
    method: "POST",
    path: "/v1/memory/bootstrap",
    // The server 415s a body-less POST here, so `{}` is always sent.
    body: {},
    headers: { "content-type": "application/json" },
  },
  {
    name: "memory.ingestDocument",
    run: (c) => c.memory.ingestDocument({ filename: "a.txt", content_base64: "aGk=", space: "personal" }),
    reply: reply({ written: 1 }),
    method: "POST",
    path: "/v1/memory/ingest/document",
    body: { filename: "a.txt", content_base64: "aGk=", space: "personal" },
  },
  {
    name: "memory.ingestMessages",
    run: (c) => c.memory.ingestMessages({ messages: [{ role: "me", body: "hi", ts_ms: 1 }] }),
    reply: reply({ written: 1 }),
    method: "POST",
    path: "/v1/memory/ingest/messages",
    body: { messages: [{ role: "me", body: "hi", ts_ms: 1 }] },
  },
  {
    name: "memory.ingestVoice",
    run: (c) => c.memory.ingestVoice({ transcript: "note", duration_ms: 10 }),
    reply: reply({ written: 1 }),
    method: "POST",
    path: "/v1/memory/ingest/voice",
    body: { transcript: "note", duration_ms: 10 },
  },

  // ── namespaces ──
  {
    name: "namespaces.listPage",
    run: (c) => c.namespaces.listPage({ limit: 1 }),
    reply: reply({ namespaces: [{ name: "acme", promotion: "pooled", keyed: false }] }),
    method: "GET",
    path: "/v1/namespaces",
    query: { limit: "1" },
  },
  {
    name: "namespaces.list",
    run: (c) => collect(c.namespaces.list()),
    reply: reply({ namespaces: [{ name: "acme", promotion: "pooled", keyed: false }] }),
    method: "GET",
    path: "/v1/namespaces",
    result: [{ name: "acme", promotion: "pooled", keyed: false }],
  },
  {
    name: "namespaces.indexDocument",
    run: (c) => c.namespaces.indexDocument("acme", { t: "x" }, { id: "d1", waitFor: "visible" }),
    reply: reply({ _id: "d1", ack: "visible_for_search" }, 201),
    method: "POST",
    path: "/v1/namespaces/acme/_doc",
    query: { wait_for: "visible" },
    body: { t: "x", _id: "d1" },
  },
  {
    name: "namespaces.bulk",
    run: (c) => c.namespaces.bulk("acme", [{ _id: "d1", t: "x" }]),
    reply: reply(bulkRes),
    method: "POST",
    path: "/v1/namespaces/acme/_bulk",
    body: { documents: [{ _id: "d1", t: "x" }] },
  },
  {
    name: "namespaces.search",
    run: (c) => c.namespaces.search("acme", { query: { match_all: {} } }),
    reply: reply(searchRes),
    method: "POST",
    path: "/v1/namespaces/acme/_search",
    body: { query: { match_all: {} } },
  },
  {
    name: "namespaces.searchAfter",
    run: (c) => collect(c.namespaces.searchAfter("acme", { sort: [{ n: { order: "desc" } }] })),
    reply: reply({ ...searchRes, hits: { total: { value: 0, relation: "gte" }, hits: [] } }),
    method: "POST",
    path: "/v1/namespaces/acme/_search",
    body: { sort: [{ n: { order: "desc" } }] },
    result: [],
  },
  {
    name: "namespaces.getDocument",
    run: (c) => c.namespaces.getDocument("acme", "d1"),
    reply: reply({ _id: "d1", _source: { t: "x" } }),
    method: "GET",
    path: "/v1/namespaces/acme/_doc/d1",
  },
  {
    name: "namespaces.deleteDocument",
    run: (c) => c.namespaces.deleteDocument("acme", "d1"),
    reply: { status: 204 },
    method: "DELETE",
    path: "/v1/namespaces/acme/_doc/d1",
    result: undefined,
  },
  {
    name: "namespaces.putMapping",
    run: (c) => c.namespaces.putMapping("vec", { fields: { v: { type: "dense_vector", dimensions: 3 } } }),
    reply: reply({ namespace: "vec", tier: "dedicated" }),
    method: "PUT",
    path: "/v1/namespaces/vec/_mapping",
    body: { fields: { v: { type: "dense_vector", dimensions: 3 } } },
  },
  {
    name: "namespaces.promote",
    run: (c) => c.namespaces.promote("acme"),
    reply: reply({ namespace: "acme", tier: "dedicated", copied: 2 }),
    method: "POST",
    path: "/v1/namespaces/acme/_promote",
  },
  {
    name: "namespaces.setKey",
    run: (c) => c.namespaces.setKey("acme", "a2V5"),
    reply: reply({ namespace: "acme", encrypted: true, unlocked: true, registered: true }),
    method: "PUT",
    path: "/v1/namespaces/acme/_key",
    body: { key: "a2V5" },
  },
  {
    name: "namespaces.keyStatus",
    run: (c) => c.namespaces.keyStatus("acme"),
    reply: reply({ namespace: "acme", encrypted: false, unlocked: false }),
    method: "GET",
    path: "/v1/namespaces/acme/_key",
  },
  {
    name: "namespaces.revokeKey",
    run: (c) => c.namespaces.revokeKey("acme"),
    reply: reply({ namespace: "acme", encrypted: false, unlocked: false }),
    method: "DELETE",
    path: "/v1/namespaces/acme/_key",
  },
  {
    name: "namespaces.delete",
    run: (c) => c.namespaces.delete("acme"),
    reply: reply({ namespace: "acme", deleted: 2 }),
    method: "DELETE",
    path: "/v1/namespaces/acme",
  },

  // ── snapshots ──
  {
    name: "snapshots.listRepositories",
    run: (c) => c.snapshots.listRepositories(),
    reply: reply({ repositories: [] }),
    method: "GET",
    path: "/v1/repositories",
  },
  {
    name: "snapshots.registerRepository",
    run: (c) => c.snapshots.registerRepository("r", { type: "fs", location: "/backups" }),
    reply: reply({ repository: "r", spec: { type: "fs", location: "/backups" } }, 201),
    method: "PUT",
    path: "/v1/repositories/r",
    body: { type: "fs", location: "/backups" },
  },
  {
    name: "snapshots.getRepository",
    run: (c) => c.snapshots.getRepository("r"),
    reply: reply({ repository: "r" }),
    method: "GET",
    path: "/v1/repositories/r",
  },
  {
    name: "snapshots.unregisterRepository",
    run: (c) => c.snapshots.unregisterRepository("r"),
    reply: reply({ repository: "r", unregistered: true }),
    method: "DELETE",
    path: "/v1/repositories/r",
  },
  {
    name: "snapshots.cleanupRepository",
    run: (c) => c.snapshots.cleanupRepository("r", { grace_seconds: 60 }),
    reply: reply({ ...job, kind: "cleanup" }, 202),
    method: "POST",
    path: "/v1/repositories/r/_cleanup",
    body: { grace_seconds: 60 },
  },
  {
    name: "snapshots.getSchedule",
    run: (c) => c.snapshots.getSchedule("r"),
    reply: reply({ repository: "r", schedule: null }),
    method: "GET",
    path: "/v1/repositories/r/schedule",
  },
  {
    name: "snapshots.setSchedule",
    run: (c) => c.snapshots.setSchedule("r", { target: "places", everyHours: 24 }),
    reply: reply({ repository: "r", schedule: { target: "places", everyHours: 24 } }),
    method: "PUT",
    path: "/v1/repositories/r/schedule",
    body: { target: "places", everyHours: 24 },
  },
  {
    name: "snapshots.clearSchedule",
    run: (c) => c.snapshots.clearSchedule("r"),
    reply: reply({ repository: "r", removed: true }),
    method: "DELETE",
    path: "/v1/repositories/r/schedule",
  },
  {
    name: "snapshots.list",
    run: (c) => c.snapshots.list("r"),
    reply: reply({ repository: "r", snapshots: ["s"] }),
    method: "GET",
    path: "/v1/repositories/r/snapshots",
  },
  {
    name: "snapshots.create",
    run: (c) => c.snapshots.create("r", "s", { index: "places" }),
    reply: reply(job, 202),
    method: "PUT",
    path: "/v1/repositories/r/snapshots/s",
    body: { index: "places" },
  },
  {
    name: "snapshots.get",
    run: (c) => c.snapshots.get("r", "s"),
    reply: reply({ snapshot: "s", signature_verified: true }),
    method: "GET",
    path: "/v1/repositories/r/snapshots/s",
  },
  {
    name: "snapshots.delete",
    run: (c) => c.snapshots.delete("r", "s"),
    reply: reply({ repository: "r", snapshot: "s", deleted: true }),
    method: "DELETE",
    path: "/v1/repositories/r/snapshots/s",
  },
  {
    name: "snapshots.restore",
    run: (c) => c.snapshots.restore("r", "s", { allow_overwrite_live_index: true }),
    reply: reply({ ...job, kind: "restore" }, 202),
    method: "POST",
    path: "/v1/repositories/r/snapshots/s/_restore",
    body: { allow_overwrite_live_index: true },
  },
  {
    name: "snapshots.listJobs",
    run: (c) => c.snapshots.listJobs(),
    reply: reply({ jobs: [job] }),
    method: "GET",
    path: "/v1/snapshot_jobs",
  },
  { name: "snapshots.getJob", run: (c) => c.snapshots.getJob("j1"), reply: reply(job), method: "GET", path: "/v1/snapshot_jobs/j1" },
  {
    name: "snapshots.waitForJob",
    run: (c) => c.snapshots.waitForJob("j1", { intervalMs: 1 }),
    reply: reply({ ...job, state: "succeeded" }),
    method: "GET",
    path: "/v1/snapshot_jobs/j1",
  },

  // ── escape hatch ──
  {
    name: "request",
    run: (c) => c.request("post", "/v1/chat/x", { json: { a: 1 }, query: { q: "1" } }),
    reply: reply({ ok: true }),
    method: "POST",
    path: "/v1/chat/x",
    query: { q: "1" },
    body: { a: 1 },
  },
];

describe("every method sends the request the description defines", () => {
  for (const row of rows) {
    it(row.name, async () => {
      const { fetch, calls } = mockFetch(row.reply);
      const c = new GnarlClient({ url: "https://node.test:9200", fetch, token: "tok" });
      const result = await row.run(c);

      expect(calls.length).toBeGreaterThan(0);
      const call = calls[calls.length - 1] as Call;
      expect(call.method).toBe(row.method);
      expect(call.url.origin).toBe("https://node.test:9200");
      expect(call.path).toBe(row.path);
      expect(call.query).toEqual(row.query ?? {});
      if (row.body !== undefined) expect(call.body).toEqual(row.body);
      else if (!row.check) expect(call.bodyText).toBeUndefined();
      for (const [k, v] of Object.entries(row.headers ?? {})) expect(call.headers[k]).toBe(v);
      expect(call.headers.authorization).toBe("Bearer tok");
      expect(call.headers.accept).toBe("application/json");
      row.check?.(call);
      expect(result).toEqual("result" in row ? row.result : row.reply.json);
    });
  }
});

function methodsOf(obj: object): string[] {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(obj)).filter(
    (k) => k !== "constructor" && typeof (obj as Record<string, unknown>)[k] === "function",
  );
}

describe("the table is complete", () => {
  it("has a row for every public method", () => {
    const c = new GnarlClient({ fetch: mockFetch().fetch });
    const surface = [
      ...methodsOf(c),
      ...methodsOf(c.node).map((m) => `node.${m}`),
      ...methodsOf(c.memory).map((m) => `memory.${m}`),
      ...methodsOf(c.namespaces).map((m) => `namespaces.${m}`),
      ...methodsOf(c.snapshots).map((m) => `snapshots.${m}`),
    ].sort();
    const covered = [...new Set(rows.map((r) => r.name))].sort();
    expect(covered).toEqual(surface);
  });
});
