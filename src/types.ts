/**
 * Friendly names for the generated payload types.
 *
 * Everything in `./generated/openapi.ts` is produced by openapi-typescript
 * from the vendored description and is never edited by hand. This file only
 * gives those types names a caller can import, so a change to the description
 * reaches every signature here through regeneration rather than by someone
 * remembering to update a hand-written copy.
 *
 * The few types below that are NOT aliases say why: each covers a route whose
 * description leaves the body untyped (`additionalProperties: true`) while the
 * server reads a fixed shape. Those are spec gaps, not client choices.
 */

import type { components, operations } from "./generated/openapi.js";

type Schemas = components["schemas"];

/** The JSON body of an operation's response for one status code. */
type JsonResponse<Op extends keyof operations, Code extends keyof operations[Op]["responses"]> = operations[Op]["responses"][Code] extends {
  content: { "application/json": infer T };
}
  ? T
  : never;

/** The JSON request body of an operation. */
type JsonRequest<Op extends keyof operations> = operations[Op] extends {
  requestBody?: { content: { "application/json": infer T } };
}
  ? T
  : never;

export type { components, operations, paths } from "./generated/openapi.js";

// ─── Errors ─────────────────────────────────────────────────────────────────

/** The `error` object of the one error envelope every `/v1` route emits. */
export type ErrorBody = Schemas["ErrorBody"];
/** `{"error": ErrorBody}` */
export type ErrorResponse = Schemas["ErrorResponse"];
/** Every error type the description names. New ones may be added. */
export type ErrorType = ErrorBody["type"];

// ─── Indexes ────────────────────────────────────────────────────────────────

export type IndexSchema = Schemas["IndexSchema"];
export type FieldDefinition = Schemas["FieldDefinition"];
export type FieldType = Schemas["FieldType"];
export type IndexMetadata = Schemas["IndexMetadata"];
export type IndexListResponse = Schemas["IndexListResponse"];
export type IndexPlacement = Schemas["IndexPlacement"];
export type IndexPolicy = Schemas["IndexPolicy"];
export type IndexPolicyUpdate = Schemas["IndexPolicyUpdate"];
export type CountResponse = JsonResponse<"countDocuments", 200>;
export type ForceMergeResponse = JsonResponse<"forceMerge", 200>;
/** `{ found, cost }` from the `_route` endpoint (a graph route; see `graphRoute`). */
export type GraphRouteResponse = JsonResponse<"explainRouting", 200>;
export type GraphBuildResponse = JsonResponse<"buildGraph", 200>;

// ─── Documents ──────────────────────────────────────────────────────────────

/** A document as written: fields at the top level, `_id` optional. */
export type Document = Schemas["IndexDocumentRequest"];
export type IndexDocumentResponse = Schemas["IndexDocumentResponse"];
export type BulkIndexResponse = Schemas["BulkIndexResponse"];
export type BulkItemResult = Schemas["BulkItemResult"];
export type BulkStreamResponse = Schemas["BulkStreamResponse"];
export type BulkStreamItem = Schemas["BulkStreamItem"];
/** Acknowledgement level a write may wait for. */
export type WaitFor = NonNullable<NonNullable<operations["indexDocument"]["parameters"]["query"]>["wait_for"]>;
/** Acknowledgement level a write reached. */
export type Ack = IndexDocumentResponse["ack"];

/** A stored document, with `_source` typed as the caller's document type. */
export type GetDocumentResponse<T = Record<string, unknown>> = Omit<Schemas["GetDocumentResponse"], "_source"> & { _source: T };

// ─── Search ─────────────────────────────────────────────────────────────────

export type SearchRequest = Schemas["SearchRequest"];
export type Query = Schemas["Query"];
export type SortClause = Schemas["SortClause"];
export type QueryScope = Schemas["QueryScope"];
export type KnnQuery = Schemas["KnnQuery"];
export type HybridQuery = Schemas["HybridQuery"];
export type GeoDistanceQuery = Schemas["GeoDistanceQuery"];
export type BoolQuery = Schemas["BoolQuery"];
export type SearchCoverage = Schemas["SearchCoverage"];
export type SkippedClaim = Schemas["SkippedClaim"];
export type SearchProfile = Schemas["SearchProfile"];
export type FanOutProfile = Schemas["FanOutProfile"];
export type ClaimRoute = Schemas["ClaimRoute"];
export type TotalHits = Schemas["TotalHits"];

/** One search hit, with `_source` typed as the caller's document type. */
export type Hit<T = Record<string, unknown>> = Omit<Schemas["Hit"], "_source"> & {
  _source?: T;
};

/** A search response whose hits carry `_source` of type `T`. */
export type SearchResponse<T = Record<string, unknown>> = Omit<Schemas["SearchResponse"], "hits"> & {
  hits: Omit<Schemas["HitsContainer"], "hits"> & { hits: Hit<T>[] };
};

// ─── Node ───────────────────────────────────────────────────────────────────

export type NodeStatus = JsonResponse<"nodeStatus", 200>;
/** Build identity. The description leaves it open; `version` is always set. */
export type NodeVersion = JsonResponse<"nodeVersion", 200> & { version?: string };
export type Entitlement = JsonResponse<"nodeEntitlement", 200>;
export type ActivationResponse = JsonResponse<"nodeActivateEntitlement", 200>;
export type NodeStats = JsonResponse<"nodeStats", 200>;
export type NodeEgress = JsonResponse<"nodeEgress", 200>;
export type NodePeers = JsonResponse<"nodePeers", 200>;
export type NodeExplain = JsonResponse<"nodeExplain", 200>;
export type NodeMesh = JsonResponse<"nodeMesh", 200>;
export type NodeContribution = JsonResponse<"nodeContribution", 200>;
export type UpdatesCheck = JsonResponse<"nodeUpdatesCheck", 200>;
export type DiscoveryRecord = JsonResponse<"bootstrapDiscover", 200>;

// ─── Memory ─────────────────────────────────────────────────────────────────

export type RememberRequest = JsonRequest<"memoryRemember">;
export type RememberResponse = JsonResponse<"memoryRemember", 200>;
export type RecallRequest = JsonRequest<"memoryRecall">;
export type RecallResponse = JsonResponse<"memoryRecall", 200>;
export type Memory = RecallResponse["memories"][number];

/**
 * `POST /v1/memory/answer`.
 *
 * The description declares `query`, `namespace`, `k` and `limit`; the server
 * also reads `space`, `user` and `session` (MemoryAnswerHttpRequest), so they
 * are declared here rather than hidden.
 */
export type AnswerRequest = JsonRequest<"memoryAnswer"> & {
  space?: string;
  user?: string;
  session?: string;
};
export type AnswerResponse = JsonResponse<"memoryAnswer", 200>;

/**
 * `POST /v1/memory/bootstrap`.
 *
 * The description declares NO request body for this route, but the server
 * requires a JSON one (MemoryBootstrapHttpRequest, every member optional).
 * The client always sends at least `{}`.
 */
export interface BootstrapRequest {
  query?: string;
  space?: string;
  namespace?: string;
  user?: string;
  session?: string;
  k?: number;
  limit?: number;
}
export type BootstrapResponse = JsonResponse<"memoryBootstrap", 200>;

/**
 * `POST /v1/memory/ingest/document`. Untyped in the description; this is the
 * server's IngestDocumentRequest. `space` is REQUIRED: `personal` stays on
 * the device, `household` is replicated to mesh peers.
 */
export interface IngestDocumentRequest {
  /** Original file name. Its extension selects the extractor and it keys dedup. */
  filename: string;
  /** The file's bytes, base64-encoded. */
  content_base64: string;
  /** `personal` (device-local) or `household` (shared with mesh peers). */
  space: string;
}

/** One message of a transcript for `POST /v1/memory/ingest/messages`. */
export interface IngestMessage {
  /** `me`, `them`, or a contact label. */
  role: string;
  body: string;
  /** Epoch milliseconds. */
  ts_ms?: number;
}

/** `POST /v1/memory/ingest/messages`. Untyped in the description; this is the server's IngestMessagesRequest. */
export interface IngestMessagesRequest {
  messages: IngestMessage[];
  space?: string;
  namespace?: string;
  user?: string;
  thread_title?: string;
  thread_id?: string;
  source?: string;
}

/** `POST /v1/memory/ingest/voice`. Untyped in the description; this is the server's IngestVoiceRequest. */
export interface IngestVoiceRequest {
  transcript: string;
  space?: string;
  namespace?: string;
  user?: string;
  duration_ms?: number;
  audio_path?: string;
  source?: string;
}

export type IngestResponse = JsonResponse<"memoryIngestDocument", 200>;

// ─── Namespaces ─────────────────────────────────────────────────────────────

export type NamespaceListResponse = JsonResponse<"listNamespaces", 200>;
export type NamespaceInfo = NonNullable<NamespaceListResponse["namespaces"]>[number];
export type NamespaceKeyStatus = Schemas["NamespaceKeyStatus"];
/** The open object the namespace mapping/promote/delete routes answer with. */
export type NamespaceResult = Record<string, unknown>;

// ─── Snapshots ──────────────────────────────────────────────────────────────

/**
 * A directory repository. The generated type carries `type: "FsRepositorySpec"`
 * because the description's discriminator has no `mapping`, so a generator
 * falls back to the schema NAME; the wire value is `fs`, and that is what this
 * type says.
 */
export type FsRepositorySpec = Omit<Schemas["FsRepositorySpec"], "type"> & { type: "fs" };
/** An S3-compatible bucket repository (wire `type: "s3"`; see `FsRepositorySpec`). */
export type S3RepositorySpec = Omit<Schemas["S3RepositorySpec"], "type"> & { type: "s3" };
/** Where a repository's bytes live. */
export type RepositorySpec = FsRepositorySpec | S3RepositorySpec;
export type RegisteredRepository = Schemas["RegisteredRepository"];
export type RepositoryList = JsonResponse<"listRepositories", 200>;
export type UnregisterResponse = JsonResponse<"unregisterRepository", 200>;
export type CreateSnapshotRequest = Schemas["CreateSnapshotRequest"];
export type RestoreRequest = Schemas["RestoreRequest"];
export type SnapshotJob = Schemas["SnapshotJob"];
export type SnapshotDescriptor = Schemas["SnapshotDescriptor"];
export type SnapshotList = JsonResponse<"listSnapshots", 200>;
export type DeleteSnapshotResponse = JsonResponse<"deleteSnapshot", 200>;
export type BackupSchedule = Schemas["BackupSchedule"];
export type BackupScheduleRequest = JsonRequest<"setBackupSchedule">;
export type ScheduleResponse = JsonResponse<"getBackupSchedule", 200>;
export type SetScheduleResponse = JsonResponse<"setBackupSchedule", 200>;
export type ClearScheduleResponse = JsonResponse<"clearBackupSchedule", 200>;
export type SnapshotJobList = JsonResponse<"listSnapshotJobs", 200>;
