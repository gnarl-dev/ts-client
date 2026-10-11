/**
 * HTTP plumbing: one `fetch` call per attempt, retry for the statuses that
 * invite one, and error mapping. Nothing here knows about any route.
 */

import { discoverLocalUrl, LOCAL_DEFAULT_URL } from "./discover.js";
import { ConnectionError, errorFromResponse, GnarlError } from "./errors.js";
import { VERSION } from "./version.js";

/**
 * The subset of a fetch `Response` this client reads. Any WHATWG-compatible
 * implementation satisfies it — the runtime's global `fetch`, undici's, Bun's,
 * Deno's, a test double.
 */
export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The request this client hands to `fetch`. */
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | ReadableStream<Uint8Array>;
  signal?: AbortSignal;
  /** Required by Node's fetch when `body` is a stream. */
  duplex?: "half";
}

/**
 * A `fetch` implementation. Typed loosely on purpose so a library's own fetch
 * (undici's, whose types are structurally the same but nominally distinct)
 * can be passed without a cast.
 */
// biome-ignore lint/suspicious/noExplicitAny: accepts any fetch's init type.
export type FetchLike = (input: string, init?: any) => Promise<ResponseLike>;

export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  /** First backoff when the server gives no `Retry-After`. Default 250 ms; doubles each retry. */
  baseDelayMs?: number;
  /**
   * The longest this client will wait between attempts. Default 10 000 ms.
   * A `Retry-After` LONGER than this is not shortened — the error is thrown
   * straight away, `retryAfter` set, so the caller decides rather than the
   * client quietly retrying sooner than the server asked.
   */
  maxDelayMs?: number;
  /** Statuses that are retried. Default `[429, 503]`. */
  statuses?: readonly number[];
}

export interface ClientOptions {
  /**
   * The node's base URL. When omitted: `$GNARL_URL`, else the endpoint the
   * node on this machine recorded (`$LUCENIA_DATA_DIR/runtime/endpoint.json`,
   * then `~/.lucenia/runtime/endpoint.json`; Node only), else
   * `http://127.0.0.1:43300` — the Gnarly app. A scheme-less address becomes
   * https, never http.
   */
  url?: string;
  /** Capability token, sent as `Authorization: Bearer …`. Default: `$GNARL_TOKEN`. */
  token?: string;
  /** The `fetch` to use. Default: the runtime's global `fetch`. */
  fetch?: FetchLike;
  /** Retry policy for idempotent requests, or `false` to never retry. */
  retry?: RetryOptions | false;
  /** Abort any single attempt after this many milliseconds. Default: no timeout. */
  timeoutMs?: number;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
}

/** Options every method accepts. */
export interface RequestOptions {
  /** Abort the request — including any retry wait — when this signal fires. */
  signal?: AbortSignal;
  /** Overrides the client's `timeoutMs` for this call. */
  timeoutMs?: number;
}

export type QueryValue = string | number | boolean | undefined;

export interface RawRequest extends RequestOptions {
  query?: Record<string, QueryValue>;
  /** Serialized as JSON with `Content-Type: application/json`. */
  json?: unknown;
  /** Sent as-is; set `contentType` alongside. */
  body?: string | Uint8Array | ReadableStream<Uint8Array>;
  contentType?: string;
  headers?: Record<string, string>;
  /**
   * Whether repeating this request is harmless. Only idempotent requests are
   * retried. Defaults from the method: GET, HEAD, PUT and DELETE are.
   */
  idempotent?: boolean;
}

function readEnv(name: string): string | undefined {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    const value = proc?.env?.[name];
    return value === undefined || value === "" ? undefined : value;
  } catch {
    // Deno without --allow-env throws on access. Absent is the right answer.
    return undefined;
  }
}

/**
 * Resolve the base URL. A scheme-less address becomes **https**: a node
 * serves TLS by default, and defaulting to http would silently downgrade a
 * caller who wrote `search.example.com`.
 */
export function normalizeBaseUrl(addr: string): string {
  const trimmed = addr.trim();
  if (trimmed === "") throw new TypeError("gnarl: empty node URL");
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new TypeError(`gnarl: ${JSON.stringify(addr)} is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`gnarl: ${JSON.stringify(addr)}: only http and https are supported`);
  }
  if (parsed.search || parsed.hash) {
    throw new TypeError(`gnarl: ${JSON.stringify(addr)}: a base URL carries no query or fragment`);
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolved retry policy. */
interface Policy {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  statuses: ReadonlySet<number>;
}

function resolvePolicy(retry: RetryOptions | false | undefined): Policy {
  if (retry === false) return { retries: 0, baseDelayMs: 0, maxDelayMs: 0, statuses: new Set() };
  const retries = retry?.retries ?? 3;
  if (!Number.isInteger(retries) || retries < 0) throw new TypeError("gnarl: retry.retries must be a non-negative integer");
  return {
    retries,
    baseDelayMs: retry?.baseDelayMs ?? 250,
    maxDelayMs: retry?.maxDelayMs ?? 10_000,
    statuses: new Set(retry?.statuses ?? [429, 503]),
  };
}

export class Transport {
  readonly baseUrl: string;
  readonly #token: string | undefined;
  readonly #fetch: FetchLike;
  readonly #policy: Policy;
  readonly #timeoutMs: number | undefined;
  readonly #headers: Record<string, string>;
  /** Injected by tests so backoff does not cost wall-clock time. */
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void> = sleep;
  /** Injected by tests to make jitter deterministic. */
  random: () => number = Math.random;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.url ?? readEnv("GNARL_URL") ?? discoverLocalUrl() ?? LOCAL_DEFAULT_URL);
    this.#token = options.token ?? readEnv("GNARL_TOKEN");
    const f = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (typeof f !== "function") {
      throw new TypeError("gnarl: no global fetch in this runtime; pass one as `fetch`");
    }
    // Bound, because some runtimes throw "Illegal invocation" when the global
    // fetch is called with a `this` other than globalThis.
    this.#fetch = options.fetch ?? f.bind(globalThis);
    this.#policy = resolvePolicy(options.retry);
    this.#timeoutMs = options.timeoutMs;
    this.#headers = { ...(options.headers ?? {}) };
  }

  /** Whether a token is configured. The token itself is never exposed. */
  get hasToken(): boolean {
    return this.#token !== undefined;
  }

  url(path: string, query?: Record<string, QueryValue>): string {
    let out = this.baseUrl + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) params.append(k, String(v));
      }
      const qs = params.toString();
      if (qs) out += `?${qs}`;
    }
    return out;
  }

  /**
   * Send one request, retrying when policy allows, and return the parsed JSON
   * body (or `undefined` for an empty one).
   */
  async request<T>(method: string, path: string, req: RawRequest = {}): Promise<T> {
    const label = `${method} ${path}`;
    const headers: Record<string, string> = { accept: "application/json", ...this.#headers };
    // A browser forbids setting User-Agent; everywhere else it identifies us.
    if (typeof (globalThis as { document?: unknown }).document === "undefined") {
      headers["user-agent"] = `gnarl-ts/${VERSION}`;
    }
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;

    let body: FetchInit["body"];
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers["content-type"] = "application/json";
    } else if (req.body !== undefined) {
      body = req.body;
      if (req.contentType) headers["content-type"] = req.contentType;
    }
    Object.assign(headers, req.headers);

    const streaming = typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
    // A stream can be read once, so a request carrying one is never retried.
    const idempotent = !streaming && (req.idempotent ?? IDEMPOTENT_METHODS.has(method));
    const url = this.url(path, req.query);
    const timeoutMs = req.timeoutMs ?? this.#timeoutMs;
    const policy = this.#policy;

    for (let attempt = 0; ; attempt++) {
      const res = await this.#attempt(url, label, { method, headers, body, duplex: streaming ? "half" : undefined }, req.signal, timeoutMs);
      const text = await res.text();
      if (res.ok) return parseBody<T>(text, res.status, label);

      const err = errorFromResponse(res.status, text, res.headers.get("retry-after"), label);
      const retryable = idempotent && policy.statuses.has(res.status) && attempt < policy.retries;
      if (!retryable) throw err;

      let delay: number;
      if (err.retryAfter !== undefined) {
        delay = err.retryAfter * 1000;
        // Honour the server, or hand the decision back — never retry sooner
        // than asked.
        if (delay > policy.maxDelayMs) throw err;
      } else {
        // Full jitter, so many clients rejected together do not return together.
        delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt) * this.random();
      }
      await this.sleep(delay, req.signal);
    }
  }

  async #attempt(
    url: string,
    label: string,
    init: FetchInit,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<ResponseLike> {
    if (signal?.aborted) throw signal.reason;
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      // The caller's own abort is theirs to handle: rethrow their reason.
      if (signal?.aborted) throw signal.reason;
      if (timedOut) {
        throw new ConnectionError({ type: "timeout", reason: `no response within ${timeoutMs} ms`, request: label, cause });
      }
      if (GnarlError.is(cause)) throw cause;
      const why = cause instanceof Error ? describeCause(cause) : String(cause);
      throw new ConnectionError({ type: "connection_error", reason: `${url}: ${why}`, request: label, cause });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Node's fetch reports "fetch failed" and hides the useful part in `cause`. */
function describeCause(err: Error): string {
  const inner = (err as { cause?: unknown }).cause;
  if (inner instanceof Error && inner.message) {
    const code = (inner as { code?: string }).code;
    return code ? `${err.message} (${code}: ${inner.message})` : `${err.message} (${inner.message})`;
  }
  return err.message;
}

function parseBody<T>(text: string, status: number, label: string): T {
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    throw new GnarlError({
      type: "invalid_response",
      reason: `response was not JSON: ${preview}`,
      status,
      request: label,
      cause,
    });
  }
}
