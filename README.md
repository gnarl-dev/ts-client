# ts-client

The TypeScript and JavaScript client for [Gnarl](https://gnarl.dev) — a
decentralized search fabric.

A node is a peer, not a coordinator, so there is no cluster endpoint to point
at. You talk to a node and it answers for the mesh. Any node will do.

```bash
npm install gnarl-client
```

Zero runtime dependencies. It runs wherever there is a WHATWG `fetch`: Node 18+,
Bun, Deno, browsers, and edge runtimes. ESM and CommonJS, with type
declarations.

## Quick start

Run the [Gnarly app](https://gnarl.dev), or start a node yourself — download
`gnarl` for your platform from
[github.com/gnarl-dev/releases](https://github.com/gnarl-dev/releases) and run
`gnarl start` (see [Connecting](#connecting) for its certificate). Then, from
Node:

```ts
import { GnarlClient } from "gnarl-client";

// No URL: $GNARL_URL, else the node on this machine — see "finds the Gnarly app" below.
const gnarl = new GnarlClient();

await gnarl.createIndex("places", {
  fields: {
    name: { type: "text" },
    country: { type: "keyword" },
    population: { type: "long" },
  },
});

// `waitFor: "visible"` returns once the write is searchable. Without it a
// write is acknowledged before it is.
await gnarl.indexDocument("places", { name: "Sydney Harbour", country: "AU", population: 5_450_000 }, { id: "sydney", waitFor: "visible" });
await gnarl.bulk(
  "places",
  [
    { _id: "lisbon", name: "Lisbon", country: "PT", population: 545_000 },
    { _id: "porto", name: "Porto", country: "PT", population: 232_000 },
  ],
  { waitFor: "visible" },
);

const res = await gnarl.search("places", { query: { term: { country: "PT" } } });
for (const hit of res.hits.hits) console.log(hit._id, hit._source?.name);

// Agent memory: store a fact, then recall it by meaning rather than keywords.
await gnarl.memory.remember({ content: "Ana prefers window seats on morning flights", user: "ana" });
const recalled = await gnarl.memory.recall({ query: "how does Ana like to fly?", user: "ana", k: 3 });
console.log(recalled.memories[0]?.content);
```

That is the whole loop: create, write, search, remember, recall.

## Connecting

### `new GnarlClient()` finds the Gnarly app on this machine

With no `url`, the client looks, in order, at:

1. `$GNARL_URL`;
2. the address the node on this machine recorded when it started, in
   `$LUCENIA_DATA_DIR/runtime/endpoint.json`, then
   `~/.lucenia/runtime/endpoint.json` — the same lookup the `gnarl` CLI makes;
3. `http://127.0.0.1:43300`, where the Gnarly desktop app listens.

The Gnarly app serves **plain HTTP on loopback**, so against it
`new GnarlClient()` just works. The recorded address is a hint, read once
when the client is built: plain HTTP is taken from it only for a loopback
host, so it can never send a request off this machine unencrypted, and an
explicit `url` (or `$GNARL_URL`) always wins. Files are read only under Node
(and Bun); in a browser or an edge worker, step 2 finds nothing and the
default applies — pass `url` there.

### A node you started with `gnarl start`

`gnarl start` also listens on **43300**, but over **https**, using a
self-signed certificate it generates on first run. Nothing signed that
certificate, so a client cannot verify it — which is right for a node **you
started yourself** and wrong for anything else. The client never turns
verification off on its own, not even on loopback: accept the certificate only
for that node, and never by habit, because a client that skips verification
will talk to whoever answers the address.

```ts
import { GnarlClient } from "gnarl-client";
import { Agent, fetch } from "undici"; // only to accept a LOCAL node's self-signed certificate

const localNode = new Agent({ connect: { rejectUnauthorized: false } });
const mine = new GnarlClient({
  fetch: (url, init) => fetch(url, { ...init, dispatcher: localNode }),
});
await mine.ping();
```

| Where the node is | What to pass |
|---|---|
| The **Gnarly desktop app**, or a node started with `--no-tls` | nothing — `new GnarlClient()` |
| A deployment with a real certificate | `new GnarlClient({ url: "https://search.example.com" })` |
| `gnarl start` on your machine, from **Node** | the undici `Agent` above |
| … from **Bun** | `fetch: (u, i) => fetch(u, { ...i, tls: { rejectUnauthorized: false } })` |
| … from **Deno** | `fetch: (u, i) => fetch(u, { ...i, client: Deno.createHttpClient({ caCerts: [pem] }) })`, or run with `--unsafely-ignore-certificate-errors=localhost` |
| … from a **browser** | open `https://localhost:43300` once and accept the certificate, or run the node with `--no-tls` |

The address and token default from the environment when `process.env`
exists, so the same code runs against a laptop and a deployment:

<!-- doctest: skip because it is a shell command -->
```bash
node app.js                                           # the Gnarly app on this machine
GNARL_URL=https://node.example.com GNARL_TOKEN=… node app.js
```

An address with no scheme becomes **https**, so `search.example.com` is never
silently downgraded to plaintext. A path prefix is kept, for a node behind a
reverse proxy.

## Errors

Every failure is a `GnarlError`. The node sends one error envelope —
`{"error": {"type", "reason", "detail"}}` — on every route, and each `type`
maps to a subclass:

| class | `type`s |
|---|---|
| `NotFoundError` | `index_not_found`, `document_not_found`, `route_not_found`, `field_not_found`, `repository_not_found`, `snapshot_not_found` |
| `AlreadyExistsError` (a `ConflictError`) | `index_already_exists` |
| `ConflictError` | `job_in_progress`, `unverified_signer` |
| `ValidationError` | `validation_error`, `schema_error`, `shared_pool`, and the framework's `text/plain` 422 |
| `UnsupportedError` | `unsupported_capability`, `unsupported_engine`, `namespace_not_snapshottable` |
| `UnauthenticatedError` / `ForbiddenError` | `unauthenticated`, `unauthorized` / `forbidden` |
| `RateLimitedError` | `rate_limited` |
| `InternalError` / `UnavailableError` | `internal_error`, `repository_error` / any 503 |
| `ConnectionError` | no response at all — refused, TLS, DNS, `timeoutMs` (`status` is 0) |

```ts
import { AlreadyExistsError, GnarlClient, NotFoundError, ValidationError } from "gnarl-client";

const gnarl = new GnarlClient();
try {
  await gnarl.createIndex("places", { fields: { name: { type: "text" } } });
} catch (err) {
  if (err instanceof AlreadyExistsError) {
    // fine, it was already there
  } else if (err instanceof ValidationError) {
    console.error("bad schema:", err.reason);
  } else {
    throw err;
  }
}

try {
  await gnarl.getDocument("places", "atlantis");
} catch (err) {
  if (!(err instanceof NotFoundError)) throw err;
  console.log(err.type); // "document_not_found" — not "index_not_found"
}
```

Each carries `type`, `reason`, `status`, an optional `detail`, `retryAfter`
(seconds, from `Retry-After`) and `request` (`"GET /v1/…"`). A `type` this
client does not know still arrives as a `GnarlError` with `type` set — never
remapped to something more familiar, because a caller branching on a guess
takes a path meant for a different failure. When a body carries no type at all
(a proxy's page, the framework's plain-text 422), `type` is `""` and the class
comes from the status.

If your application ends up loading both the ESM and CommonJS builds,
`instanceof` across them is false; `GnarlError.is(err)` is not fooled.

### Retries

Idempotent requests that get **429** or **503** are retried — three times by
default, honouring `Retry-After`, with jittered exponential backoff when the
node gives none. A `Retry-After` longer than `maxDelayMs` is not shortened:
the error is thrown at once, `retryAfter` set, so you decide.

"Idempotent" means GET, PUT and DELETE, plus the POSTs that are reads (search,
recall, answer) and writes that name their `_id` or carry an
`idempotencyKey`. A write the node would mint a new id for is never retried,
nor is a streamed body.

```ts
import { GnarlClient } from "gnarl-client";

const patient = new GnarlClient({ retry: { retries: 5, maxDelayMs: 30_000 } });
const strict = new GnarlClient({ retry: false, timeoutMs: 5_000 });
await patient.ping();
await strict.ping();
```

Every method also takes `{ signal, timeoutMs }`; aborting stops a retry wait
too.

## Memory for AI apps

`memory` is durable recall for an assistant: `remember` embeds and stores a
fact on the node (on-device, no API key), `recall` ranks by a fused lexical +
vector score, and `answer` composes over what it recalled. Scope memories with
`user`, `session` and `agent`. A typical agent turn recalls before it answers
and remembers what it learned after:

```ts
import { GnarlClient } from "gnarl-client";

const gnarl = new GnarlClient();

/** Stand-in for your model call. */
async function callModel(prompt: string): Promise<string> {
  return `(model reply to ${prompt.length} chars of prompt)`;
}

async function agentTurn(user: string, message: string): Promise<string> {
  // 1. Recall what matters for this message, scoped to this user.
  const { memories } = await gnarl.memory.recall({ query: message, user, k: 5 });
  const context = memories.map((m) => `- ${m.content}`).join("\n");

  // 2. Answer with that context.
  const reply = await callModel(`Known about the user:\n${context}\n\nUser: ${message}`);

  // 3. Keep anything worth knowing next time.
  if (/\b(prefer|always|never|my name is)\b/i.test(message)) {
    await gnarl.memory.remember({ content: message, user, fact_type: "preference" });
  }
  return reply;
}

console.log(await agentTurn("sam", "I always want answers in metric units."));
console.log(await agentTurn("sam", "How far is a marathon?"));
```

`recall` clamps `k` above 100 to 100 rather than rejecting it. `tags` go in as
an object and come back on a recalled memory as a flat `"k=v,k=v"` string.
`memory.bootstrap()` returns the space's defaults and a seed recall for the
start of a session; `ingestDocument`, `ingestMessages` and `ingestVoice` accept
files (base64), chat transcripts and voice transcripts.

## Search

The request and response types are generated from the API description, so an
editor completes the query DSL:

```ts
import { GnarlClient } from "gnarl-client";

interface Place {
  name: string;
  country: string;
  population: number;
}

const gnarl = new GnarlClient();
const res = await gnarl.search<Place>("places", {
  query: {
    bool: {
      must: [{ match: { name: "lisbon" } }],
      filter: [{ range: { population: { gte: 100_000 } } }],
    },
  },
  size: 5,
});
for (const hit of res.hits.hits) console.log(hit._source?.population);

// `total` is a LOWER BOUND unless relation is "eq".
console.log(res.hits.total.relation === "eq" ? "exactly" : "at least", res.hits.total.value);
```

Deep result sets: walk them with `search_after`, which costs the same per page
however deep it goes. It needs an explicit `sort`:

```ts
import { GnarlClient } from "gnarl-client";

const gnarl = new GnarlClient();
let n = 0;
for await (const hit of gnarl.searchAfter("places", { query: { match_all: {} }, sort: [{ population: { order: "desc" } }], size: 500 })) {
  n++;
  if (n === 1) console.log("largest:", hit._id);
}
console.log(n, "places");
```

`listIndexes()` and `namespaces.list()` follow the listing cursor the same way.

### Completeness and tamper evidence

A search spans claims held by many peers, and a node answers with whatever it
could reach. Every response carries `coverage`. For anything auditable, ask
for all or nothing:

```ts
import { GnarlClient, IncompleteResultError } from "gnarl-client";

const gnarl = new GnarlClient();
try {
  const res = await gnarl.search("places", { query: { match_all: {} }, verify: true }, { requireComplete: true });
  console.log(`complete and proven: ${res.coverage.served_claims} claims`);
} catch (err) {
  if (!(err instanceof IncompleteResultError)) throw err;
  // The partial result rides on the error, so you can degrade deliberately.
  console.log(err.reason);
}
```

`verify: true` requires every served claim to be **proven** against an anchor
the node holds independently of whoever served it; `requireComplete` requires
every claim to **answer**. `profile: true` returns the fan-out — which peer
served each claim and what its proof came to.

## Bulk writes

A bulk request can return 200 with individual items failed — the most common
way to lose writes silently. `failedItems` makes the check a one-liner, and
items are in request order, so an item's index is its document's:

```ts
import { failedItems, GnarlClient } from "gnarl-client";

const gnarl = new GnarlClient();
const result = await gnarl.bulk("places", [
  { _id: "rome", name: "Rome", country: "IT", population: 2_870_000 },
  { _id: "nowhere", name: "Nowhere", population: "lots" }, // not a long
]);
for (const item of failedItems(result)) console.log("failed:", item._id, item.error?.reason);
```

For more documents than belong in one request, `bulkChunked` takes any
iterable or async iterable and yields each chunk's response with its
`offset`; `bulkStream` sends NDJSON to `_bulk_stream` as a `ReadableStream`,
encoded lazily, which the node ingests in micro-batches as it arrives:

```ts
import { failedItems, GnarlClient } from "gnarl-client";

const gnarl = new GnarlClient();
function* towns() {
  for (let i = 0; i < 2_000; i++) yield { _id: `town-${i}`, name: `Town ${i}`, country: "XX", population: i };
}

for await (const { offset, response } of gnarl.bulkChunked("places", towns(), { chunkSize: 500 })) {
  for (const [i, item] of response.items.entries()) if (item.error) console.log(`document ${offset + i}:`, item.error.reason);
}

const streamed = await gnarl.bulkStream("places", towns(), { waitFor: "durable" });
console.log(streamed.items.length, "streamed,", failedItems(streamed).length, "failed");
```

## Namespaces

Many lightweight tenants over shared pools: name one and write. The first
write creates it, and every search is confined to it by a filter the caller
cannot override.

```ts
import { GnarlClient } from "gnarl-client";

const gnarl = new GnarlClient();
await gnarl.namespaces.indexDocument("tenant-a", { subject: "Q3 board pack" }, { id: "doc-1", waitFor: "visible" });
await gnarl.namespaces.indexDocument("tenant-b", { subject: "Q3 offsite" }, { id: "doc-1", waitFor: "visible" });

const res = await gnarl.namespaces.search("tenant-a", { query: { match: { subject: "q3" } } });
console.log(res.hits.hits.map((h) => h._source)); // tenant-a's document only

for await (const ns of gnarl.namespaces.list()) console.log(ns.name, ns.promotion);
```

`promote` moves a pooled namespace to its own index online; `putMapping`
declares a `dense_vector` field (vector search needs a dedicated namespace);
`setKey` / `keyStatus` / `revokeKey` manage a tenant's own encryption key.

## Snapshots

Register a repository (a directory, or any S3-compatible bucket), snapshot an
index or a namespace, and restore. Snapshot, restore and cleanup are jobs:

<!-- doctest: skip because it writes to a host directory -->
```ts
import { GnarlClient } from "gnarl-client";

const gnarl = new GnarlClient();
await gnarl.snapshots.registerRepository("nightly", { type: "fs", location: "/var/backups/gnarl" });
const started = await gnarl.snapshots.create("nightly", "places-2026-10-09", { index: "places" });
const job = await gnarl.snapshots.waitForJob(started.id as string);
if (job.state !== "succeeded") throw new Error(job.error);

await gnarl.snapshots.setSchedule("nightly", { target: "places", everyHours: 24 });
```

A restore refuses a snapshot whose signer the node cannot verify unless you
pass `signer_public_key` or `allow_unverified_signer`, and refuses to roll a
live index back without `allow_overwrite_live_index`.

## Everything else

| | |
|---|---|
| node | `ping`, `version`, `status`, `entitlement`, `activate(key)`, and `node.stats / egress / peers / explain / mesh / contribution / updatesCheck / discover` |
| indexes | `createIndex`, `getIndex`, `indexExists`, `deleteIndex`, `listIndexes` (async iterator), `listIndexesPage`, `getSchema`, `count`, `forcemerge`, `getPolicy`, `putPolicy`, `buildGraph`, `graphRoute` |
| documents | `indexDocument`, `getDocument`, `deleteDocument`, `bulk`, `bulkChunked`, `bulkStream`, `bulkProto` |
| search | `search`, `searchAfter` |
| memory | `remember`, `recall`, `answer`, `bootstrap`, `ingestDocument`, `ingestMessages`, `ingestVoice` |
| namespaces | `list`, `listPage`, `indexDocument`, `bulk`, `search`, `searchAfter`, `getDocument`, `deleteDocument`, `putMapping`, `promote`, `setKey`, `keyStatus`, `revokeKey`, `delete` |
| snapshots | `listRepositories`, `registerRepository`, `getRepository`, `unregisterRepository`, `cleanupRepository`, `getSchedule`, `setSchedule`, `clearSchedule`, `list`, `create`, `get`, `delete`, `restore`, `listJobs`, `getJob`, `waitForJob` |
| anything else | `gnarl.request(method, path, { json, query })` — same auth, retry and errors |

**Subscriptions.** `entitlement()` has three states, not two: `active` is
verified now, a non-null `refused` is a key that is present and rejected
(expired, or signed by a key this build does not trust), and neither means
none was activated. `not_after` is epoch **seconds**. `activate(key)` verifies
before it stores; a refusal is a `ValidationError` whose `reason` names why.

**Counts are per node.** `count()` counts the claims *this* node holds;
`partial: true` means the number is a floor.

**Deletes are durable before they are invisible.** A read straight after
`deleteDocument` can still see the document until the next commit; poll for
`document_not_found` rather than asserting absence at once.

**Four field names are reserved**: `id`, `version`, `title` and
`canonical_url` belong to the document envelope, so declaring one is rejected
at index creation. Use `name`, `headline` or `subject` instead of `title`.

**`geo_distance` is flat and in metres**: `{ geo_distance: { field, lat, lon, radius_meters } }` —
no nested `location`, no `"10km"`.

## Authentication

A node with RBAC enabled (a private mesh) exempts loopback callers, so a local
node needs no token. A remote one does:

<!-- doctest: skip because it needs a remote node and a token -->
```ts
import { GnarlClient } from "gnarl-client";

const gnarl = new GnarlClient({ url: "https://node.example.com", token: process.env.GNARL_TOKEN });
```

## How this package is built

`src/generated/openapi.ts` is **generated** by
[openapi-typescript](https://openapi-ts.dev) from the node's API description,
vendored byte-for-byte at `spec/openapi.yaml`, and is never edited by hand —
so the payload types cannot drift from the server. Everything else is written
by hand so it can be idiomatic. Regenerate with:

<!-- doctest: skip because it is a shell command -->
```bash
npm run generate
```

`--default-non-nullable false` is not cosmetic: without it every request field
with a default (`from`, `size`, …) becomes *required*. CI regenerates and fails
if the output differs, and fails if `spec/openapi.yaml` is not the server's
current description. The description also ships in the package, as
`gnarl-client/openapi.yaml`.

Where the description and the server disagree, the client sends what the
server reads, says so in the method's documentation, and the gap is reported
upstream:

- `graphRoute` / `buildGraph` — the description documents `_route` as a
  document-routing lookup taking `id`, and `_graph/build` as taking nothing;
  the server serves a graph shortest-path query (`field`, `weight_field`,
  `from`, `to`) and requires `field` and `weight_field` to build.
- `memory.bootstrap` — the description declares no request body; the server
  requires a JSON one, so the client always sends `{}` at least.
- `memory.answer` and the `ingest*` routes — untyped in the description; the
  request types here are transcribed from the server.
- `RepositorySpec` — the description's discriminator has no `mapping`, so a
  generator types `type` as the schema name; the wire value is `fs` / `s3`.
- `namespaces.deleteDocument` — the node answers `204` with no body, not the
  documented `200` object.

## Tests

| layer | where | what it proves |
|---|---|---|
| unit | `test/unit/` | every method sends the exact request (verb, path, query, body, headers) against a recording `fetch`; every error type maps; retry, timeout and abort behave |
| conformance | `test/conformance/` | a real node boots and answers real HTTP: the quick start, entitlement, memory remember → recall, namespace isolation, pagination, bulk, snapshots, and the rate limiter's `Retry-After` |
| doc tests | `test/conformance/readme.test.ts` | every `ts` example in this README runs, in order, against that node |

<!-- doctest: skip because it is a shell command -->
```bash
npm test                                            # unit
npm run test:conformance                            # starts a node from ../lucenia, or skips
LUCENIA_BIN=/path/to/gnarl npm run test:conformance # a binary of your choosing
GNARL_TEST_NODE=http://127.0.0.1:PORT npm run test:conformance  # a throwaway node you already run
```

A table in `test/unit/methods.test.ts` lists every public method; a test
enumerates the client by reflection and fails if one has no row. And the
tests are themselves checked: `node scripts/mutation-check.mjs` breaks each
method in turn — makes it do nothing, sends it to the wrong path, gives it the
wrong verb — and fails if the unit suite still passes.

## License

Apache-2.0. The node itself is AGPL-3.0-or-later; the client is permissive so
it can be embedded freely.
