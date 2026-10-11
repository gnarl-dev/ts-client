/**
 * `GnarlClient` — the hand-written surface over the generated types.
 *
 * A node is a peer, not a coordinator, so there is no cluster endpoint to
 * point at: you talk to a node and it answers for the mesh. Any node will do.
 */

import { GnarlError, IncompleteResultError, NotFoundError } from "./errors.js";
import { chunk, documentBody, toNdjson } from "./helpers.js";
import { type ClientOptions, type QueryValue, type RawRequest, type RequestOptions, Transport } from "./transport.js";
import type {
  ActivationResponse,
  AnswerRequest,
  AnswerResponse,
  BackupScheduleRequest,
  BootstrapRequest,
  BootstrapResponse,
  BulkIndexResponse,
  BulkStreamResponse,
  ClearScheduleResponse,
  CountResponse,
  CreateSnapshotRequest,
  DeleteSnapshotResponse,
  DiscoveryRecord,
  Entitlement,
  ForceMergeResponse,
  GetDocumentResponse,
  GraphBuildResponse,
  GraphRouteResponse,
  Hit,
  IndexDocumentResponse,
  IndexListResponse,
  IndexMetadata,
  IndexPolicy,
  IndexPolicyUpdate,
  IndexSchema,
  IngestDocumentRequest,
  IngestMessagesRequest,
  IngestResponse,
  IngestVoiceRequest,
  NamespaceInfo,
  NamespaceKeyStatus,
  NamespaceListResponse,
  NamespaceResult,
  NodeContribution,
  NodeEgress,
  NodeExplain,
  NodeMesh,
  NodePeers,
  NodeStats,
  NodeStatus,
  NodeVersion,
  RecallRequest,
  RecallResponse,
  RegisteredRepository,
  RememberRequest,
  RememberResponse,
  RepositoryList,
  RepositorySpec,
  RestoreRequest,
  ScheduleResponse,
  SearchRequest,
  SearchResponse,
  SetScheduleResponse,
  SnapshotDescriptor,
  SnapshotJob,
  SnapshotJobList,
  SnapshotList,
  UnregisterResponse,
  UpdatesCheck,
  WaitFor,
} from "./types.js";

type Doc = Record<string, unknown>;

/** Options for a write. */
export interface WriteOptions extends RequestOptions {
  /**
   * How far the write must get before the call returns: `accepted` (no
   * wait), `durable`, or `visible` — searchable immediately. Without it a
   * document is acknowledged before it is searchable.
   */
  waitFor?: WaitFor;
  /** Longest the node may wait for `waitFor`. The node's default is 30 000. */
  waitForTimeoutMs?: number;
  /**
   * Opaque key (≤128 chars) binding this write to the same `_id`(s) on retry,
   * so an ambiguous outcome retried does not mint a second document. Sending
   * one also makes the write safe for this client to retry on 429/503.
   */
  idempotencyKey?: string;
}

/** Namespace writes take no idempotency key; the route does not read one. */
export type NamespaceWriteOptions = Omit<WriteOptions, "idempotencyKey">;

/** Options for a search. */
export interface SearchOptions extends RequestOptions {
  /**
   * Throw `IncompleteResultError` unless every claim answered. The partial
   * response rides on the error. Off by default: interactive search wants
   * what could be reached; an audit wants all or nothing.
   */
  requireComplete?: boolean;
}

/** Options for a cursor-following listing. */
export interface ListOptions extends RequestOptions {
  /** Entries per page (node default 1000, cap 10 000). */
  limit?: number;
  /** Start after this cursor rather than at the beginning. */
  after?: string;
}

/** Parameters for `buildGraph`. */
export interface GraphBuildParams {
  /** The `graph_edge` field. */
  field: string;
  /** Numeric field holding each edge's weight. */
  weightField: string;
  /** Contraction order: `degree` (default) or `inertial` (needs `coordField`). */
  order?: "degree" | "inertial";
  /** geo_point field supplying node coordinates for `inertial` order. */
  coordField?: string;
}

/** Parameters for `graphRoute`. */
export interface GraphRouteParams {
  field: string;
  weightField: string;
  /** Source graph node id (non-negative). */
  from: number;
  /** Target graph node id (non-negative). */
  to: number;
}

/** One chunk's outcome from `bulkChunked`. */
export interface BulkChunkResult {
  /** Position of this chunk's first document in the input. */
  offset: number;
  response: BulkIndexResponse;
}

function seg(value: string, what: string): string {
  if (typeof value !== "string" || value === "") throw new TypeError(`gnarl: ${what} must be a non-empty string`);
  // A document id is caller data and may contain '/', '?' or '#'.
  return encodeURIComponent(value);
}

function writeQuery(opts: WriteOptions | undefined): Record<string, QueryValue> {
  return { wait_for: opts?.waitFor, wait_for_timeout_ms: opts?.waitForTimeoutMs };
}

function writeHeaders(opts: WriteOptions | undefined): Record<string, string> | undefined {
  return opts?.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : undefined;
}

function base(opts: RequestOptions | undefined): RequestOptions {
  return { signal: opts?.signal, timeoutMs: opts?.timeoutMs };
}

function bulkBody(docs: readonly Doc[]): { documents: Doc[] } {
  if (!Array.isArray(docs)) throw new TypeError("gnarl: bulk: documents must be an array");
  if (docs.length === 0) throw new RangeError("gnarl: bulk: no documents");
  return {
    documents: docs.map((d, i) => {
      try {
        return documentBody(d);
      } catch (err) {
        throw new TypeError(`gnarl: bulk: document ${i}: ${(err as Error).message}`);
      }
    }),
  };
}

function checkComplete<T>(res: SearchResponse<T>): void {
  const cov = res.coverage;
  // Both conditions: `partial` is the node's verdict, the arithmetic catches
  // an unserved claim it did not flag.
  if (res.partial || cov.served_claims < cov.expected_claims) {
    throw new IncompleteResultError(res, cov.served_claims, cov.expected_claims, cov.skipped_claims.length);
  }
}

async function* paginate<P, I>(
  fetchPage: (after: string | undefined) => Promise<P>,
  items: (page: P) => I[] | undefined,
  next: (page: P) => string | undefined,
  start: string | undefined,
): AsyncGenerator<I> {
  let after = start;
  for (;;) {
    const page = await fetchPage(after);
    for (const item of items(page) ?? []) yield item;
    const cursor = next(page);
    if (cursor === undefined || cursor === "") return;
    if (cursor === after) {
      throw new GnarlError({ type: "invalid_response", reason: `listing cursor did not advance (${cursor})` });
    }
    after = cursor;
  }
}

async function* walkSearchAfter<T>(
  search: (req: SearchRequest) => Promise<SearchResponse<T>>,
  request: SearchRequest,
): AsyncGenerator<Hit<T>> {
  if (!request.sort || request.sort.length === 0) {
    throw new TypeError("gnarl: searchAfter needs an explicit `sort` — the cursor is the last hit's sort values");
  }
  const { from: _ignored, ...rest } = request;
  let after = request.search_after;
  for (;;) {
    const page = await search(after === undefined ? rest : { ...rest, search_after: after });
    const hits = page.hits.hits;
    if (hits.length === 0) return;
    yield* hits;
    const cursor = hits[hits.length - 1]?.sort;
    if (!cursor || cursor.length === 0) {
      throw new GnarlError({ type: "invalid_response", reason: "the last hit carried no `sort` values to continue from" });
    }
    if (after !== undefined && JSON.stringify(cursor) === JSON.stringify(after)) {
      throw new GnarlError({ type: "invalid_response", reason: "search_after cursor did not advance" });
    }
    after = cursor;
  }
}

/** Node introspection beyond `status`/`version`. Every read is safe to poll. */
export class NodeApi {
  constructor(private readonly t: Transport) {}

  /** Counters for queries, ingest and storage. */
  stats(opts?: RequestOptions): Promise<NodeStats> {
    return this.t.request("GET", "/v1/node/stats", base(opts));
  }
  /** Outbound gossip bytes by message type, heaviest first. */
  egress(opts?: RequestOptions): Promise<NodeEgress> {
    return this.t.request("GET", "/v1/node/egress", base(opts));
  }
  /** Known peers with reachability and RTT. */
  peers(opts?: RequestOptions): Promise<NodePeers> {
    return this.t.request("GET", "/v1/node/peers", base(opts));
  }
  /** Resolved settings and why each was chosen. */
  explain(opts?: RequestOptions): Promise<NodeExplain> {
    return this.t.request("GET", "/v1/node/explain", base(opts));
  }
  /** Mesh scope, name and membership state. */
  mesh(opts?: RequestOptions): Promise<NodeMesh> {
    return this.t.request("GET", "/v1/node/mesh", base(opts));
  }
  /** What this node has contributed to the mesh. */
  contribution(opts?: RequestOptions): Promise<NodeContribution> {
    return this.t.request("GET", "/v1/node/contribution", base(opts));
  }
  /** Whether a newer release is available. */
  updatesCheck(opts?: RequestOptions): Promise<UpdatesCheck> {
    return this.t.request("GET", "/v1/node/updates/check", base(opts));
  }
  /** This node's discovery record (`GET /v1/bootstrap/discover`). */
  discover(opts?: RequestOptions): Promise<DiscoveryRecord> {
    return this.t.request("GET", "/v1/bootstrap/discover", base(opts));
  }
}

/**
 * Agent memory: durable recall for assistants. `remember` stores a fact,
 * `recall` retrieves by hybrid lexical + vector search, `answer` composes over
 * what was recalled, and `ingest*` accept documents, transcripts and voice.
 */
export class MemoryApi {
  constructor(private readonly t: Transport) {}

  /**
   * Store a memory. Not retried: each call stores a new memory with a new id.
   * On a node with no embedding model and no route to fetch one this fails
   * fast with an error naming where to install it.
   */
  remember(request: RememberRequest, opts?: RequestOptions): Promise<RememberResponse> {
    return this.t
      .request<RememberResponse>("POST", "/v1/memory/remember", { ...base(opts), json: request, idempotent: false })
      .then(publicEngine);
  }

  /** Recall memories ranked by fused lexical + vector score. `k` above 100 is clamped to 100. */
  recall(request: RecallRequest, opts?: RequestOptions): Promise<RecallResponse> {
    return this.t
      .request<RecallResponse>("POST", "/v1/memory/recall", { ...base(opts), json: request, idempotent: true })
      .then(withEmbedder);
  }

  /** Answer a question over recalled memories. */
  answer(request: AnswerRequest, opts?: RequestOptions): Promise<AnswerResponse> {
    return this.t.request("POST", "/v1/memory/answer", { ...base(opts), json: request, idempotent: true });
  }

  /** Prepare a memory space (and recall a starting context, when `query` is given). */
  bootstrap(request: BootstrapRequest = {}, opts?: RequestOptions): Promise<BootstrapResponse> {
    return this.t.request("POST", "/v1/memory/bootstrap", { ...base(opts), json: request, idempotent: true });
  }

  /** Ingest a document supplied as base64 bytes. `space` is required. */
  ingestDocument(request: IngestDocumentRequest, opts?: RequestOptions): Promise<IngestResponse> {
    return this.t.request("POST", "/v1/memory/ingest/document", { ...base(opts), json: request });
  }

  /** Ingest a chat or SMS transcript. */
  ingestMessages(request: IngestMessagesRequest, opts?: RequestOptions): Promise<IngestResponse> {
    return this.t.request("POST", "/v1/memory/ingest/messages", { ...base(opts), json: request });
  }

  /** Ingest a transcribed voice memo. */
  ingestVoice(request: IngestVoiceRequest, opts?: RequestOptions): Promise<IngestResponse> {
    return this.t.request("POST", "/v1/memory/ingest/voice", { ...base(opts), json: request });
  }
}

/**
 * Namespaces: many lightweight tenants over bounded physical pools — name one
 * and write. The first write creates it; every search is confined to it by a
 * filter the caller cannot override.
 */
export class NamespacesApi {
  constructor(private readonly t: Transport) {}

  /** One page of namespaces. */
  listPage(opts?: ListOptions): Promise<NamespaceListResponse> {
    return this.t.request("GET", "/v1/namespaces", { ...base(opts), query: { after: opts?.after, limit: opts?.limit } });
  }

  /**
   * Every namespace, following `next_after` across pages. A page with
   * `partial: true` (a peer was unreachable) is still yielded; use `listPage`
   * when you need to see that flag.
   */
  list(opts?: ListOptions): AsyncGenerator<NamespaceInfo> {
    return paginate(
      (after) => this.listPage({ ...opts, after }),
      (p) => p.namespaces,
      (p) => p.next_after,
      opts?.after,
    );
  }

  /** Write one document, creating the namespace on first write. */
  indexDocument(ns: string, doc: Doc, opts?: NamespaceWriteOptions & { id?: string }): Promise<IndexDocumentResponse> {
    const body = documentBody(doc, opts?.id);
    return this.t.request("POST", `/v1/namespaces/${seg(ns, "namespace")}/_doc`, {
      ...base(opts),
      json: body,
      query: writeQuery(opts),
      idempotent: body._id !== undefined,
    });
  }

  /** Write many documents in one request. Always 200 — read per-item `status`. */
  bulk(ns: string, docs: readonly Doc[], opts?: NamespaceWriteOptions): Promise<BulkIndexResponse> {
    const body = bulkBody(docs);
    return this.t.request("POST", `/v1/namespaces/${seg(ns, "namespace")}/_bulk`, {
      ...base(opts),
      json: body,
      query: writeQuery(opts),
      idempotent: body.documents.every((d) => d._id !== undefined),
    });
  }

  /** Search within the namespace. kNN needs a dedicated (vector) namespace. */
  async search<T = Doc>(ns: string, request: SearchRequest = {}, opts?: SearchOptions): Promise<SearchResponse<T>> {
    const res = await this.t.request<SearchResponse<T>>("POST", `/v1/namespaces/${seg(ns, "namespace")}/_search`, {
      ...base(opts),
      json: request,
      idempotent: true,
    });
    if (opts?.requireComplete) checkComplete(res);
    return res;
  }

  /** Walk every hit with `search_after` keyset pagination. Needs an explicit `sort`. */
  searchAfter<T = Doc>(ns: string, request: SearchRequest, opts?: SearchOptions): AsyncGenerator<Hit<T>> {
    return walkSearchAfter((req) => this.search<T>(ns, req, opts), request);
  }

  /** Fetch one document. */
  getDocument<T = Doc>(ns: string, id: string, opts?: RequestOptions): Promise<GetDocumentResponse<T>> {
    return this.t.request("GET", `/v1/namespaces/${seg(ns, "namespace")}/_doc/${seg(id, "document id")}`, base(opts));
  }

  /**
   * Delete one document. Durable on return; may stay readable briefly. The
   * node answers `204` with no body (the description says `200` and an
   * object), so this resolves to `undefined` today.
   */
  deleteDocument(ns: string, id: string, opts?: RequestOptions): Promise<NamespaceResult | undefined> {
    return this.t.request("DELETE", `/v1/namespaces/${seg(ns, "namespace")}/_doc/${seg(id, "document id")}`, base(opts));
  }

  /** Declare a dense_vector mapping, moving a FRESH namespace to its own index. */
  putMapping(ns: string, schema: IndexSchema, opts?: RequestOptions): Promise<NamespaceResult> {
    return this.t.request("PUT", `/v1/namespaces/${seg(ns, "namespace")}/_mapping`, { ...base(opts), json: schema });
  }

  /** Promote a pooled namespace to a dedicated index, online. Idempotent. */
  promote(ns: string, opts?: RequestOptions): Promise<NamespaceResult> {
    return this.t.request("POST", `/v1/namespaces/${seg(ns, "namespace")}/_promote`, { ...base(opts), idempotent: true });
  }

  /** Register or unlock the namespace's BYOK key (base64, 32 bytes). Admin on a private mesh. */
  setKey(ns: string, key: string, opts?: RequestOptions): Promise<NamespaceKeyStatus> {
    return this.t.request("PUT", `/v1/namespaces/${seg(ns, "namespace")}/_key`, { ...base(opts), json: { key } });
  }

  /** Whether the namespace is keyed and unlocked. Never returns key material. */
  keyStatus(ns: string, opts?: RequestOptions): Promise<NamespaceKeyStatus> {
    return this.t.request("GET", `/v1/namespaces/${seg(ns, "namespace")}/_key`, base(opts));
  }

  /** Revoke the key: crypto-erase, leaving a fail-closed tombstone. Admin on a private mesh. */
  revokeKey(ns: string, opts?: RequestOptions): Promise<NamespaceKeyStatus> {
    return this.t.request("DELETE", `/v1/namespaces/${seg(ns, "namespace")}/_key`, base(opts));
  }

  /** Delete the whole namespace. Admin on a private mesh. */
  delete(ns: string, opts?: RequestOptions): Promise<NamespaceResult> {
    return this.t.request("DELETE", `/v1/namespaces/${seg(ns, "namespace")}`, base(opts));
  }
}

/**
 * Backup and restore. Every route requires `admin` on a private mesh (loopback
 * is exempt). Snapshot, restore and cleanup are jobs: they return `202` with a
 * `SnapshotJob`, and `waitForJob` polls one to completion.
 */
export class SnapshotsApi {
  constructor(private readonly t: Transport) {}

  listRepositories(opts?: RequestOptions): Promise<RepositoryList> {
    return this.t.request("GET", "/v1/repositories", base(opts));
  }

  /** Register (or replace) a repository. It is opened and listed before it is accepted. */
  registerRepository(repo: string, spec: RepositorySpec, opts?: RequestOptions): Promise<RegisteredRepository> {
    return this.t.request("PUT", `/v1/repositories/${seg(repo, "repository")}`, { ...base(opts), json: spec });
  }

  getRepository(repo: string, opts?: RequestOptions): Promise<RegisteredRepository> {
    return this.t.request("GET", `/v1/repositories/${seg(repo, "repository")}`, base(opts));
  }

  /** Forget a repository. Its data is left alone. */
  unregisterRepository(repo: string, opts?: RequestOptions): Promise<UnregisterResponse> {
    return this.t.request("DELETE", `/v1/repositories/${seg(repo, "repository")}`, base(opts));
  }

  /** Reclaim segments no snapshot references, keeping anything younger than `graceSeconds` (default 86 400). */
  cleanupRepository(repo: string, request: { grace_seconds?: number } = {}, opts?: RequestOptions): Promise<SnapshotJob> {
    return this.t.request("POST", `/v1/repositories/${seg(repo, "repository")}/_cleanup`, { ...base(opts), json: request });
  }

  /** The repository's backup schedule; `schedule` is null when none is set. */
  getSchedule(repo: string, opts?: RequestOptions): Promise<ScheduleResponse> {
    return this.t.request("GET", `/v1/repositories/${seg(repo, "repository")}/schedule`, base(opts));
  }

  /** Back the repository up every `everyHours` (1–168), in UTC windows. */
  setSchedule(repo: string, schedule: BackupScheduleRequest, opts?: RequestOptions): Promise<SetScheduleResponse> {
    return this.t.request("PUT", `/v1/repositories/${seg(repo, "repository")}/schedule`, { ...base(opts), json: schedule });
  }

  /** Stop scheduled backups. Removing an absent schedule is not an error. */
  clearSchedule(repo: string, opts?: RequestOptions): Promise<ClearScheduleResponse> {
    return this.t.request("DELETE", `/v1/repositories/${seg(repo, "repository")}/schedule`, base(opts));
  }

  /** Snapshot names in a repository. */
  list(repo: string, opts?: RequestOptions): Promise<SnapshotList> {
    return this.t.request("GET", `/v1/repositories/${seg(repo, "repository")}/snapshots`, base(opts));
  }

  /** Start a snapshot of an index or a namespace. Returns the job. */
  create(repo: string, snapshot: string, request: CreateSnapshotRequest, opts?: RequestOptions): Promise<SnapshotJob> {
    return this.t.request("PUT", `/v1/repositories/${seg(repo, "repository")}/snapshots/${seg(snapshot, "snapshot")}`, {
      ...base(opts),
      json: request,
    });
  }

  /** A snapshot's signed descriptor, with `signature_verified`. */
  get(repo: string, snapshot: string, opts?: RequestOptions): Promise<SnapshotDescriptor> {
    return this.t.request("GET", `/v1/repositories/${seg(repo, "repository")}/snapshots/${seg(snapshot, "snapshot")}`, base(opts));
  }

  /** Delete a snapshot's descriptor. Segments are reclaimed by `cleanupRepository`. */
  delete(repo: string, snapshot: string, opts?: RequestOptions): Promise<DeleteSnapshotResponse> {
    return this.t.request("DELETE", `/v1/repositories/${seg(repo, "repository")}/snapshots/${seg(snapshot, "snapshot")}`, base(opts));
  }

  /** Start a restore. Refuses an unverifiable signer unless told otherwise. */
  restore(repo: string, snapshot: string, request: RestoreRequest = {}, opts?: RequestOptions): Promise<SnapshotJob> {
    return this.t.request("POST", `/v1/repositories/${seg(repo, "repository")}/snapshots/${seg(snapshot, "snapshot")}/_restore`, {
      ...base(opts),
      json: request,
    });
  }

  /** Snapshot jobs, newest first. */
  listJobs(opts?: RequestOptions): Promise<SnapshotJobList> {
    return this.t.request("GET", "/v1/snapshot_jobs", base(opts));
  }

  getJob(id: string, opts?: RequestOptions): Promise<SnapshotJob> {
    return this.t.request("GET", `/v1/snapshot_jobs/${seg(id, "job id")}`, base(opts));
  }

  /**
   * Poll a job until it leaves `running`, and return it. A `failed` job is
   * RETURNED, not thrown — read `state` and `error`.
   */
  async waitForJob(id: string, opts: RequestOptions & { intervalMs?: number; deadlineMs?: number } = {}): Promise<SnapshotJob> {
    const interval = opts.intervalMs ?? 500;
    const deadline = Date.now() + (opts.deadlineMs ?? 300_000);
    for (;;) {
      const job = await this.getJob(id, opts);
      if (job.state !== "running") return job;
      if (Date.now() + interval > deadline) {
        throw new GnarlError({ type: "timeout", reason: `snapshot job ${id} still running after ${opts.deadlineMs ?? 300_000} ms` });
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, interval);
        opts.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(opts.signal?.reason);
          },
          { once: true },
        );
      });
    }
  }
}

/**
 * A client for one Gnarl node.
 *
 * ```ts
 * const gnarl = new GnarlClient();                       // $GNARL_URL or https://localhost:8080
 * const gnarl = new GnarlClient({ url: "http://localhost:8080" }); // a --no-tls / desktop node
 * ```
 */
export class GnarlClient {
  readonly #t: Transport;
  /** Node introspection beyond status and version. */
  readonly node: NodeApi;
  /** Agent memory. */
  readonly memory: MemoryApi;
  /** Lightweight tenants over shared pools. */
  readonly namespaces: NamespacesApi;
  /** Repositories, snapshots, schedules and jobs. */
  readonly snapshots: SnapshotsApi;

  constructor(options: ClientOptions = {}) {
    this.#t = new Transport(options);
    this.node = new NodeApi(this.#t);
    this.memory = new MemoryApi(this.#t);
    this.namespaces = new NamespacesApi(this.#t);
    this.snapshots = new SnapshotsApi(this.#t);
  }

  /** The resolved base URL every request goes to. */
  get url(): string {
    return this.#t.baseUrl;
  }

  /**
   * Send a request to a route this client does not wrap, with the same auth,
   * retry and error handling. `path` starts with `/`.
   */
  request<T = unknown>(method: string, path: string, req?: RawRequest): Promise<T> {
    if (!path.startsWith("/")) throw new TypeError("gnarl: path must start with '/'");
    return this.#t.request<T>(method.toUpperCase(), path, req);
  }

  // ── node ─────────────────────────────────────────────────────────────────

  /** Resolves when the node answers; throws a `GnarlError` when it does not. */
  async ping(opts?: RequestOptions): Promise<void> {
    await this.#t.request("GET", "/v1/node/status", base(opts));
  }

  /** The node's build identity (`version`, `name`, `brand`, `node_id`, …). */
  version(opts?: RequestOptions): Promise<NodeVersion> {
    return this.#t.request("GET", "/v1/node/version", base(opts));
  }

  /** Identity, peers, claims, mode, load, connectivity, admission, storage. */
  status(opts?: RequestOptions): Promise<NodeStatus> {
    return this.#t.request("GET", "/v1/node/status", base(opts));
  }

  /**
   * The subscription this node holds. Three states, not two: `active` is
   * verified now; a non-null `refused` is a key that is present and rejected
   * (expired, or signed by an untrusted key); neither means none was
   * activated. `enforced: false` means this build gates nothing.
   * `not_after` is epoch SECONDS.
   */
  entitlement(opts?: RequestOptions): Promise<Entitlement> {
    return this.#t.request("GET", "/v1/node/entitlement", base(opts));
  }

  /**
   * Activate a subscription from a pasted key (`gnarl-ent1.…` or the raw
   * signed JSON). The key is verified before it is stored; a refusal is a
   * `ValidationError` whose `reason` says malformed, expired or untrusted.
   * Scope changes take effect at the next node start.
   */
  activate(key: string, opts?: RequestOptions): Promise<ActivationResponse> {
    if (typeof key !== "string" || key.trim() === "") throw new TypeError("gnarl: activation key must be a non-empty string");
    return this.#t.request("POST", "/v1/node/entitlement/activate", { ...base(opts), json: { key: key.trim() } });
  }

  // ── indexes ──────────────────────────────────────────────────────────────

  /** Create an index. The engine is bound from the schema's field types, permanently. */
  createIndex(name: string, schema: IndexSchema, opts?: RequestOptions): Promise<IndexMetadata> {
    if (!schema || typeof schema !== "object" || !("fields" in schema)) {
      throw new TypeError("gnarl: createIndex takes a schema, `{ fields: { … } }`");
    }
    return this.#t
      .request<IndexMetadata>("PUT", `/v1/indexes/${seg(name, "index name")}`, { ...base(opts), json: { schema } })
      .then(publicEngine);
  }

  /** Index metadata: schema, engine binding, claim count. */
  getIndex(name: string, opts?: RequestOptions): Promise<IndexMetadata> {
    return this.#t.request<IndexMetadata>("GET", `/v1/indexes/${seg(name, "index name")}`, base(opts)).then(publicEngine);
  }

  /**
   * Whether the index exists. `false` ONLY for `index_not_found`: any other
   * 404 — a route that is not there, a proxy's page — is thrown, because
   * reporting it as "no such index" would be a guess.
   */
  async indexExists(name: string, opts?: RequestOptions): Promise<boolean> {
    try {
      await this.getIndex(name, opts);
      return true;
    } catch (err) {
      if (err instanceof NotFoundError && err.type === "index_not_found") return false;
      throw err;
    }
  }

  deleteIndex(name: string, opts?: RequestOptions): Promise<void> {
    return this.#t.request("DELETE", `/v1/indexes/${seg(name, "index name")}`, base(opts));
  }

  /** One page of indexes. */
  listIndexesPage(opts?: ListOptions): Promise<IndexListResponse> {
    return this.#t
      .request<IndexListResponse>("GET", "/v1/indexes", {
        ...base(opts),
        query: { after: opts?.after, limit: opts?.limit },
      })
      .then((page) => ({ ...page, indexes: page.indexes.map(publicEngine) }));
  }

  /**
   * Every index, following `next_after` until it is absent. A page may be
   * short without being the last, so this never stops at a short page.
   *
   * ```ts
   * for await (const index of gnarl.listIndexes()) console.log(index.name);
   * ```
   */
  listIndexes(opts?: ListOptions): AsyncGenerator<IndexMetadata> {
    return paginate(
      (after) => this.listIndexesPage({ ...opts, after }),
      (p) => p.indexes,
      (p) => p.next_after,
      opts?.after,
    );
  }

  getSchema(name: string, opts?: RequestOptions): Promise<IndexSchema> {
    return this.#t.request("GET", `/v1/indexes/${seg(name, "index name")}/_schema`, base(opts));
  }

  /**
   * Documents in the claims THIS node holds. `partial: true` means the count
   * is a floor — some claims live elsewhere or were still materializing.
   */
  count(name: string, opts?: RequestOptions): Promise<CountResponse> {
    return this.#t.request("GET", `/v1/indexes/${seg(name, "index name")}/_count`, base(opts));
  }

  /** Merge segments of the locally-held claims. Expensive; for quiet periods. */
  forcemerge(name: string, opts?: RequestOptions & { maxNumSegments?: number }): Promise<ForceMergeResponse> {
    return this.#t.request("POST", `/v1/indexes/${seg(name, "index name")}/_forcemerge`, {
      ...base(opts),
      query: { max_num_segments: opts?.maxNumSegments },
      idempotent: true,
    });
  }

  /**
   * Build the routing graph (a contraction hierarchy) over an index's
   * `graph_edge` field, weighted by `weightField`. Needed before `graphRoute`.
   *
   * The description lists no parameters for this route; the server REQUIRES
   * `field` and `weight_field`, which is what this sends.
   */
  buildGraph(name: string, params: GraphBuildParams, opts?: RequestOptions): Promise<GraphBuildResponse> {
    return this.#t.request("POST", `/v1/indexes/${seg(name, "index name")}/_graph/build`, {
      ...base(opts),
      query: { field: params.field, weight_field: params.weightField, order: params.order, coord_field: params.coordField },
      idempotent: true,
    });
  }

  /**
   * Cheapest path between two graph nodes over a built graph (`buildGraph`):
   * `{ found, cost }`.
   *
   * The description calls this route `explainRouting` and gives it an `id`
   * parameter; the server actually serves this graph query and rejects `id`.
   * This sends what the server reads.
   */
  graphRoute(name: string, params: GraphRouteParams, opts?: RequestOptions): Promise<GraphRouteResponse> {
    return this.#t.request("GET", `/v1/indexes/${seg(name, "index name")}/_route`, {
      ...base(opts),
      query: { field: params.field, weight_field: params.weightField, from: params.from, to: params.to },
    });
  }

  /** How far the index's data may travel. */
  getPolicy(name: string, opts?: RequestOptions): Promise<IndexPolicy> {
    return this.#t.request("GET", `/v1/indexes/${seg(name, "index name")}/_policy`, base(opts));
  }

  /**
   * Change placement or replication. ORIGIN ONLY — another node answers
   * `ForbiddenError`. Omitted fields are unchanged; narrowing drops replicas.
   */
  putPolicy(name: string, update: IndexPolicyUpdate, opts?: RequestOptions): Promise<IndexPolicy> {
    return this.#t.request("PUT", `/v1/indexes/${seg(name, "index name")}/_policy`, { ...base(opts), json: update });
  }

  // ── documents ────────────────────────────────────────────────────────────

  /**
   * Index one document. Pass `id` to choose its `_id` (or include `_id` in
   * the document); otherwise one is minted. With an id or an
   * `idempotencyKey` the write is safe to retry and this client will.
   */
  indexDocument(index: string, doc: Doc, opts?: WriteOptions & { id?: string }): Promise<IndexDocumentResponse> {
    const body = documentBody(doc, opts?.id);
    return this.#t.request("POST", `/v1/indexes/${seg(index, "index name")}/_doc`, {
      ...base(opts),
      json: body,
      query: writeQuery(opts),
      headers: writeHeaders(opts),
      idempotent: body._id !== undefined || opts?.idempotencyKey !== undefined,
    });
  }

  /** Fetch one document. A missing one is `NotFoundError` with type `document_not_found`. */
  getDocument<T = Doc>(index: string, id: string, opts?: RequestOptions): Promise<GetDocumentResponse<T>> {
    return this.#t.request("GET", `/v1/indexes/${seg(index, "index name")}/_doc/${seg(id, "document id")}`, base(opts));
  }

  /**
   * Delete one document. Acknowledged when DURABLE, not when invisible: a read
   * straight afterwards may still see it until the next commit.
   */
  deleteDocument(index: string, id: string, opts?: RequestOptions): Promise<void> {
    return this.#t.request("DELETE", `/v1/indexes/${seg(index, "index name")}/_doc/${seg(id, "document id")}`, base(opts));
  }

  /**
   * Write many documents in one request. **A 200 does not mean every document
   * landed** — use `failedItems(result)`. Items are in request order.
   */
  bulk(index: string, docs: readonly Doc[], opts?: WriteOptions): Promise<BulkIndexResponse> {
    const body = bulkBody(docs);
    return this.#t.request("POST", `/v1/indexes/${seg(index, "index name")}/_bulk`, {
      ...base(opts),
      json: body,
      query: writeQuery(opts),
      headers: writeHeaders(opts),
      idempotent: opts?.idempotencyKey !== undefined || body.documents.every((d) => d._id !== undefined),
    });
  }

  /**
   * Write any number of documents — an array, a generator, an async stream —
   * as sequential `_bulk` requests of `chunkSize` (default 500). Yields each
   * chunk's response with the `offset` of its first document, so an item's
   * input position is `offset + i`.
   */
  async *bulkChunked(
    index: string,
    docs: Iterable<Doc> | AsyncIterable<Doc>,
    opts?: Omit<WriteOptions, "idempotencyKey"> & { chunkSize?: number },
  ): AsyncGenerator<BulkChunkResult> {
    let offset = 0;
    for await (const batch of chunk(docs, opts?.chunkSize ?? 500)) {
      const response = await this.bulk(index, batch, opts);
      yield { offset, response };
      offset += batch.length;
    }
  }

  /**
   * Stream documents as NDJSON to `_bulk_stream`; the node ingests in
   * micro-batches as bytes arrive. Pass documents (any iterable or async
   * iterable — encoded lazily) or a ready-made NDJSON `ReadableStream`.
   * Never retried, since a stream can be read once.
   *
   * Streaming request bodies need `duplex: "half"` support: Node 18+, Deno
   * and Bun have it; browsers only over HTTP/2.
   */
  bulkStream(
    index: string,
    source: ReadableStream<Uint8Array> | Iterable<Doc> | AsyncIterable<Doc>,
    opts?: Omit<WriteOptions, "idempotencyKey">,
  ): Promise<BulkStreamResponse> {
    const body =
      typeof ReadableStream !== "undefined" && source instanceof ReadableStream
        ? (source as ReadableStream<Uint8Array>)
        : toNdjson(source as Iterable<Doc> | AsyncIterable<Doc>);
    return this.#t.request("POST", `/v1/indexes/${seg(index, "index name")}/_bulk_stream`, {
      ...base(opts),
      body,
      contentType: "application/x-ndjson",
      query: writeQuery(opts),
    });
  }

  /**
   * Send an already-encoded `BulkIngestRequest` protobuf to `_bulk_proto`.
   * This client ships no protobuf runtime; bring your own encoder. Set
   * `contentEncoding: "zstd"` when the bytes are zstd-compressed.
   */
  bulkProto(
    index: string,
    bytes: Uint8Array,
    opts?: Omit<WriteOptions, "idempotencyKey" | "waitFor"> & { waitFor?: "durable"; contentEncoding?: "zstd" | "identity" },
  ): Promise<BulkStreamResponse> {
    return this.#t.request("POST", `/v1/indexes/${seg(index, "index name")}/_bulk_proto`, {
      ...base(opts),
      body: bytes,
      contentType: "application/x-protobuf",
      headers: opts?.contentEncoding ? { "content-encoding": opts.contentEncoding } : undefined,
      query: writeQuery(opts),
    });
  }

  // ── search ───────────────────────────────────────────────────────────────

  /**
   * Search an index. Every response carries `coverage`; `partial: true` means
   * some claims did not answer. Set `requireComplete` to make that an error.
   *
   * ```ts
   * const res = await gnarl.search<Product>("products", { query: { match: { name: "chair" } } });
   * for (const hit of res.hits.hits) console.log(hit._id, hit._source?.name);
   * ```
   */
  async search<T = Doc>(index: string, request: SearchRequest = {}, opts?: SearchOptions): Promise<SearchResponse<T>> {
    const res = await this.#t.request<SearchResponse<T>>("POST", `/v1/indexes/${seg(index, "index name")}/_search`, {
      ...base(opts),
      json: request,
      idempotent: true,
    });
    if (opts?.requireComplete) checkComplete(res);
    return res;
  }

  /**
   * Walk every matching hit with `search_after` keyset pagination: each page
   * costs the same however deep, and it is stable under concurrent writes.
   * Requires an explicit `sort` (on a reasonably distinct field); `size` sets
   * the page size and `from` is ignored.
   *
   * ```ts
   * for await (const hit of gnarl.searchAfter("logs", { sort: [{ ts: { order: "asc" } }], size: 1000 })) { … }
   * ```
   */
  searchAfter<T = Doc>(index: string, request: SearchRequest, opts?: SearchOptions): AsyncGenerator<Hit<T>> {
    return walkSearchAfter((req) => this.search<T>(index, req, opts), request);
  }
}

/**
 * Nodes released before the engine was named `native` report it by its old
 * internal binding, `tantivy`. It is the same engine; the name is translated
 * here so no caller ever sees two names for it, whichever node they talk to.
 */
function publicEngine<T extends { engine_binding?: string | null }>(meta: T): T {
  return (meta.engine_binding as string) === "tantivy" ? { ...meta, engine_binding: "native" } : meta;
}

/**
 * Nodes up to 0.1.0-rc29 answer a recall over a namespace nothing was ever
 * written to with `{namespace, count: 0, memories: []}` — no `embedder`, which
 * the contract declares required. The field is filled with `""` ("the node did
 * not say") so the type stays true at run time, whichever node answered.
 */
function withEmbedder(res: RecallResponse): RecallResponse {
  return typeof res?.embedder === "string" ? res : { ...res, embedder: "" };
}
