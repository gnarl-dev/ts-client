/**
 * The one error type a caller has to handle.
 *
 * A node emits a single error envelope on every `/v1` route:
 *
 *     {"error": {"type": "...", "reason": "...", "detail": {...}}}
 *
 * so there is one class, `GnarlError`, and a subclass per family of `type` so
 * `instanceof` can do the matching. Two things arrive WITHOUT that envelope and
 * are still turned into a `GnarlError` rather than something else:
 *
 * - the HTTP framework's own `422 text/plain` for a body that does not
 *   deserialize at all, which answers before any handler runs, and
 * - anything a proxy or load balancer says on the node's behalf.
 *
 * Both fall back to the HTTP status, with `type` left empty — an absent type is
 * reported as absent rather than guessed, because a caller branching on a guess
 * takes the path meant for a different failure.
 */

import type { ErrorType } from "./types.js";

const BRAND = Symbol.for("@gnarl/client.GnarlError");

export interface GnarlErrorInit {
  /** The wire `error.type`, or `""` when the body carried none. */
  type?: ErrorType | (string & {});
  /** The wire `error.reason` — human-readable, always worth logging. */
  reason?: string;
  /** HTTP status. `0` when no response arrived at all. */
  status?: number;
  /** Structured detail for capability and engine errors. Shape varies by type. */
  detail?: Record<string, unknown>;
  /** Seconds the server asked the caller to wait, from `Retry-After`. */
  retryAfter?: number;
  /** The request that failed, as `METHOD /path`. */
  request?: string;
  cause?: unknown;
}

/**
 * A failure reported by a node, or the failure to reach one.
 *
 * `type` is stable and safe to switch on: the description promises new types
 * may be added and existing ones are never removed or renamed. Prefer the
 * subclasses, which are the same idea expressed for `instanceof`.
 */
export class GnarlError extends Error {
  // Spelled out rather than read from the constructor, which a minifier renames.
  override name = "GnarlError";
  /** The wire `error.type`, or `""` when the body carried none. */
  readonly type: ErrorType | (string & {});
  /** The wire `error.reason`. */
  readonly reason: string;
  /** HTTP status; `0` when no response arrived. */
  readonly status: number;
  /** Structured detail, when the node supplied it. */
  readonly detail: Record<string, unknown> | undefined;
  /** Seconds to wait before retrying, from `Retry-After`. `undefined` when the server did not say. */
  readonly retryAfter: number | undefined;
  /** `METHOD /path` of the request that failed. */
  readonly request: string | undefined;

  constructor(init: GnarlErrorInit = {}) {
    const type = init.type ?? "";
    const reason = init.reason ?? "";
    const status = init.status ?? 0;
    const head = reason ? `${type || "error"}: ${reason}` : `${type || "error"} (HTTP ${status})`;
    super(init.request ? `${head} [${init.request}]` : head, init.cause === undefined ? undefined : { cause: init.cause });
    this.type = type;
    this.reason = reason;
    this.status = status;
    this.detail = init.detail;
    this.retryAfter = init.retryAfter;
    this.request = init.request;
    Object.defineProperty(this, BRAND, { value: true });
  }

  /**
   * `instanceof` that survives the dual-package hazard: when an application
   * ends up loading both the ESM and the CommonJS build, each has its own
   * class and `instanceof` across them is false. This checks a global brand.
   */
  static is(value: unknown): value is GnarlError {
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
  }

  /** The server's backoff hint in seconds, or `fallback` when it gave none. */
  retryAfterOr(fallback: number): number {
    return this.retryAfter ?? fallback;
  }
}

/** An index, document, namespace, repository, snapshot, job or route that is not there. */
export class NotFoundError extends GnarlError {
  override name = "NotFoundError";
}
/** The request conflicts with the node's state: a job already running, an unverifiable signer. */
export class ConflictError extends GnarlError {
  override name = "ConflictError";
}
/** Creating something that already exists. A `ConflictError`. */
export class AlreadyExistsError extends ConflictError {
  override name = "AlreadyExistsError";
}
/** The request was refused as malformed or contradictory (including the framework's text/plain 422). */
export class ValidationError extends GnarlError {
  override name = "ValidationError";
}
/** No token, an expired one, or one this node will not accept. */
export class UnauthenticatedError extends GnarlError {
  override name = "UnauthenticatedError";
}
/** Authenticated, but not permitted — or, for `_policy`, not this index's origin. */
export class ForbiddenError extends GnarlError {
  override name = "ForbiddenError";
}
/** Too many requests. `retryAfter` carries the server's hint. */
export class RateLimitedError extends GnarlError {
  override name = "RateLimitedError";
}
/** The field, engine or capability cannot do what was asked. */
export class UnsupportedError extends GnarlError {
  override name = "UnsupportedError";
}
/** The node failed in a way it does not attribute to the caller. */
export class InternalError extends GnarlError {
  override name = "InternalError";
}
/** 503: the node, or something in front of it, cannot serve this now. */
export class UnavailableError extends GnarlError {
  override name = "UnavailableError";
}
/** No response at all: DNS, refused connection, TLS, an abort or a timeout. `status` is 0. */
export class ConnectionError extends GnarlError {
  override name = "ConnectionError";
}

/**
 * Thrown when `requireComplete` was set and coverage fell short. Carries the
 * partial response so a caller can inspect it, or degrade to it deliberately,
 * rather than lose the work.
 */
export class IncompleteResultError<R = unknown> extends GnarlError {
  override name = "IncompleteResultError";
  readonly response: R;
  constructor(response: R, served: number, expected: number, skipped: number) {
    super({
      type: "incomplete",
      reason: `${served} of ${expected} claims answered, ${skipped} skipped (requireComplete was set)`,
    });
    this.response = response;
  }
}

type ErrorClass = new (init: GnarlErrorInit) => GnarlError;

/**
 * Wire type → class. Exhaustive over the description's ErrorType enum: the
 * `satisfies` makes a type added to the description without a mapping here a
 * compile error after regeneration, rather than a silent fallback.
 */
const BY_TYPE = {
  validation_error: ValidationError,
  schema_error: ValidationError,
  shared_pool: ValidationError,
  unsupported_capability: UnsupportedError,
  unsupported_engine: UnsupportedError,
  namespace_not_snapshottable: UnsupportedError,
  index_not_found: NotFoundError,
  document_not_found: NotFoundError,
  route_not_found: NotFoundError,
  field_not_found: NotFoundError,
  repository_not_found: NotFoundError,
  snapshot_not_found: NotFoundError,
  index_already_exists: AlreadyExistsError,
  job_in_progress: ConflictError,
  unverified_signer: ConflictError,
  unauthorized: UnauthenticatedError,
  unauthenticated: UnauthenticatedError,
  forbidden: ForbiddenError,
  rate_limited: RateLimitedError,
  internal_error: InternalError,
  repository_error: InternalError,
} as const satisfies Record<ErrorType, ErrorClass>;

/** For a body with no recognisable type — a proxy's 404, the framework's 422. */
const BY_STATUS: Record<number, ErrorClass> = {
  400: ValidationError,
  401: UnauthenticatedError,
  403: ForbiddenError,
  404: NotFoundError,
  409: ConflictError,
  422: ValidationError,
  429: RateLimitedError,
  500: InternalError,
  503: UnavailableError,
};

/**
 * Parse `Retry-After`: delta-seconds, or an HTTP-date. Returns seconds, or
 * `undefined` when the header is absent or unparseable.
 */
export function parseRetryAfter(raw: string | null | undefined, now: number = Date.now()): number | undefined {
  if (raw == null) return undefined;
  const text = raw.trim();
  if (text === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  // An HTTP-date names a weekday and month. Without this, Date.parse reads
  // "-1" as the year -1 and a negative delay becomes "retry now".
  if (!/[a-z]{3}/i.test(text)) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

const MAX_REASON = 512;

/**
 * Turn a non-2xx response into the right error. Never loses the status, and
 * never invents a type the body did not carry.
 */
export function errorFromResponse(status: number, bodyText: string, retryAfterHeader?: string | null, request?: string): GnarlError {
  const retryAfter = parseRetryAfter(retryAfterHeader);
  let envelope: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const inner = (parsed as { error?: unknown } | null)?.error;
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
      envelope = inner as Record<string, unknown>;
    }
  } catch {
    // not JSON — handled below
  }

  if (envelope === undefined) {
    let text = bodyText.trim();
    if (text.length > MAX_REASON) text = `${text.slice(0, MAX_REASON)}…`;
    const Cls = BY_STATUS[status] ?? GnarlError;
    return new Cls({ type: "", reason: text, status, retryAfter, request });
  }

  const type = typeof envelope.type === "string" ? envelope.type : "";
  // `message` is the deprecated alias for `reason`; read only as a fallback.
  const reason =
    (typeof envelope.reason === "string" && envelope.reason) || (typeof envelope.message === "string" && envelope.message) || "";
  const detail = typeof envelope.detail === "object" && envelope.detail !== null ? (envelope.detail as Record<string, unknown>) : undefined;
  const Cls: ErrorClass = (BY_TYPE as Record<string, ErrorClass>)[type] ?? BY_STATUS[status] ?? GnarlError;
  return new Cls({ type, reason, status, detail, retryAfter, request });
}
