import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionError,
  GnarlClient,
  GnarlError,
  normalizeBaseUrl,
  RateLimitedError,
  UnavailableError,
  ValidationError,
  VERSION,
} from "../../src/index.js";
import type { ClientOptions } from "../../src/transport.js";
import { Transport } from "../../src/transport.js";
import { mockFetch, type Reply, reply } from "./mock.js";

const rateLimited = (retryAfter?: string): Reply => ({
  status: 429,
  json: { error: { type: "rate_limited", reason: "slow down" } },
  headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
});
// biome-ignore lint/suspicious/noExplicitAny: assertions read error fields.
const failure = (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => expect.unreachable("expected a rejection"),
    (e) => e,
  );
const unavailable = { status: 503, text: "upstream unavailable" };

function transport(fetch: ReturnType<typeof mockFetch>["fetch"], retry?: ClientOptions["retry"]) {
  const t = new Transport({ url: "https://n.test", fetch, retry });
  const sleeps: number[] = [];
  t.sleep = async (ms) => {
    sleeps.push(ms);
  };
  t.random = () => 0.5;
  return { t, sleeps };
}

describe("base URL", () => {
  it("adds https to a scheme-less address, never http", () => {
    expect(normalizeBaseUrl("search.example.com")).toBe("https://search.example.com");
    expect(normalizeBaseUrl("localhost:8080")).toBe("https://localhost:8080");
  });
  it("keeps an explicit http (a --no-tls or desktop node)", () => {
    expect(normalizeBaseUrl("http://localhost:8080/")).toBe("http://localhost:8080");
  });
  it("keeps a path prefix for a node behind a reverse proxy", () => {
    expect(normalizeBaseUrl("https://proxy.test/gnarl/")).toBe("https://proxy.test/gnarl");
  });
  it("rejects what is not a usable base", () => {
    expect(() => normalizeBaseUrl("")).toThrow(TypeError);
    expect(() => normalizeBaseUrl("ftp://x")).toThrow(/only http and https/);
    expect(() => normalizeBaseUrl("https://x/?a=1")).toThrow(/no query/);
  });
});

describe("defaults", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses https://localhost:8080 with no option and no environment", () => {
    vi.stubEnv("GNARL_URL", "");
    vi.stubEnv("GNARL_TOKEN", "");
    const c = new GnarlClient({ fetch: mockFetch().fetch });
    expect(c.url).toBe("https://localhost:8080");
  });

  it("reads GNARL_URL and GNARL_TOKEN", async () => {
    vi.stubEnv("GNARL_URL", "http://127.0.0.1:9999");
    vi.stubEnv("GNARL_TOKEN", "envtok");
    const { fetch, calls } = mockFetch(reply({}));
    const c = new GnarlClient({ fetch });
    await c.status();
    expect(calls[0]?.url.origin).toBe("http://127.0.0.1:9999");
    expect(calls[0]?.headers.authorization).toBe("Bearer envtok");
  });

  it("lets explicit options win over the environment", async () => {
    vi.stubEnv("GNARL_URL", "http://env.test");
    vi.stubEnv("GNARL_TOKEN", "envtok");
    const { fetch, calls } = mockFetch(reply({}));
    await new GnarlClient({ fetch, url: "https://opt.test", token: "opttok" }).status();
    expect(calls[0]?.url.origin).toBe("https://opt.test");
    expect(calls[0]?.headers.authorization).toBe("Bearer opttok");
  });

  it("sends no Authorization header without a token", async () => {
    vi.stubEnv("GNARL_TOKEN", "");
    const { fetch, calls } = mockFetch(reply({}));
    await new GnarlClient({ fetch, url: "https://n.test" }).status();
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it("identifies itself and merges extra headers", async () => {
    const { fetch, calls } = mockFetch(reply({}));
    await new GnarlClient({ fetch, url: "https://n.test", headers: { "x-trace": "1" } }).status();
    expect(calls[0]?.headers["user-agent"]).toBe(`gnarl-ts/${VERSION}`);
    expect(calls[0]?.headers["x-trace"]).toBe("1");
  });

  it("falls back to the global fetch", async () => {
    const { fetch, calls } = mockFetch(reply({ version: "1" }));
    vi.stubGlobal("fetch", fetch);
    try {
      await new GnarlClient({ url: "https://n.test" }).version();
      expect(calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("responses", () => {
  it("returns undefined for an empty 2xx body", async () => {
    const { t } = transport(mockFetch({ status: 204 }).fetch);
    expect(await t.request("DELETE", "/v1/x")).toBeUndefined();
  });

  it("reports a 2xx that is not JSON rather than returning garbage", async () => {
    const { t } = transport(mockFetch({ status: 200, text: "<html>console</html>" }).fetch);
    const err = await failure(t.request("GET", "/v1/x"));
    expect(err).toBeInstanceOf(GnarlError);
    expect(err.type).toBe("invalid_response");
    expect(err.request).toBe("GET /v1/x");
  });

  it("drops undefined query values and encodes the rest", () => {
    const { t } = transport(mockFetch().fetch);
    expect(t.url("/v1/x", { a: "1 2", b: undefined, c: 3, d: false })).toBe("https://n.test/v1/x?a=1+2&c=3&d=false");
  });
});

describe("retry", () => {
  it("retries a 429 on an idempotent request, honouring Retry-After", async () => {
    const m = mockFetch(rateLimited("2"), reply({ ok: 1 }));
    const { t, sleeps } = transport(m.fetch);
    expect(await t.request("GET", "/v1/x")).toEqual({ ok: 1 });
    expect(m.calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("retries a 503 with exponential backoff and jitter when no Retry-After", async () => {
    const m = mockFetch(unavailable, unavailable, reply({ ok: 1 }));
    const { t, sleeps } = transport(m.fetch, { baseDelayMs: 100 });
    expect(await t.request("PUT", "/v1/x", { json: {} })).toEqual({ ok: 1 });
    // random() is pinned at 0.5: 100 * 2^0 * .5, 100 * 2^1 * .5
    expect(sleeps).toEqual([50, 100]);
  });

  it("accepts an HTTP-date Retry-After", async () => {
    const at = new Date(Date.now() + 3000).toUTCString();
    const m = mockFetch(rateLimited(at), reply({}));
    const { t, sleeps } = transport(m.fetch);
    await t.request("GET", "/v1/x");
    expect(sleeps[0]).toBeGreaterThan(1000);
    expect(sleeps[0]).toBeLessThanOrEqual(3000);
  });

  it("does not retry a non-idempotent POST", async () => {
    const m = mockFetch(unavailable, reply({}));
    const { t } = transport(m.fetch);
    await expect(t.request("POST", "/v1/memory/remember", { json: {} })).rejects.toBeInstanceOf(UnavailableError);
    expect(m.calls).toHaveLength(1);
  });

  it("retries a POST the caller marks idempotent", async () => {
    const m = mockFetch(unavailable, reply({ hits: 1 }));
    const { t } = transport(m.fetch);
    expect(await t.request("POST", "/v1/indexes/x/_search", { json: {}, idempotent: true })).toEqual({ hits: 1 });
    expect(m.calls).toHaveLength(2);
  });

  it("never retries a streamed body", async () => {
    const m = mockFetch(unavailable, reply({}));
    const { t } = transport(m.fetch);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{}\n"));
        c.close();
      },
    });
    await expect(t.request("PUT", "/v1/x", { body, idempotent: true })).rejects.toBeInstanceOf(UnavailableError);
    expect(m.calls).toHaveLength(1);
  });

  it("gives up after `retries` and throws the last error", async () => {
    const m = mockFetch(rateLimited("0"));
    const { t } = transport(m.fetch, { retries: 2 });
    const err = await failure(t.request("GET", "/v1/x"));
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfter).toBe(0);
    expect(m.calls).toHaveLength(3);
  });

  it("throws at once when Retry-After exceeds maxDelayMs, rather than retrying early", async () => {
    const m = mockFetch(rateLimited("60"), reply({}));
    const { t, sleeps } = transport(m.fetch, { maxDelayMs: 5000 });
    const err = await failure(t.request("GET", "/v1/x"));
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfter).toBe(60);
    expect(sleeps).toEqual([]);
    expect(m.calls).toHaveLength(1);
  });

  it("can be disabled", async () => {
    const m = mockFetch(rateLimited("0"), reply({}));
    const { t } = transport(m.fetch, false);
    await expect(t.request("GET", "/v1/x")).rejects.toBeInstanceOf(RateLimitedError);
    expect(m.calls).toHaveLength(1);
  });

  it("does not retry statuses outside the policy", async () => {
    const m = mockFetch({ status: 500, json: { error: { type: "internal_error", reason: "x" } } }, reply({}));
    const { t } = transport(m.fetch);
    await expect(t.request("GET", "/v1/x")).rejects.toThrow(/internal_error/);
    expect(m.calls).toHaveLength(1);
  });

  it("rejects a nonsensical retry count", () => {
    expect(() => new Transport({ fetch: mockFetch().fetch, retry: { retries: -1 } })).toThrow(TypeError);
  });

  it("uses the real sleep and stops waiting when aborted", async () => {
    const m = mockFetch(rateLimited("5"), reply({}));
    const t = new Transport({ url: "https://n.test", fetch: m.fetch });
    const ac = new AbortController();
    const p = t.request("GET", "/v1/x", { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("caller gave up")), 20);
    await expect(p).rejects.toThrow("caller gave up");
    expect(m.calls).toHaveLength(1);
  });
});

describe("write retry safety", () => {
  it("retries indexDocument only when it carries an _id or an idempotency key", async () => {
    const withId = mockFetch(unavailable, reply({ _id: "a", ack: "accepted" }, 201));
    await new GnarlClient({ url: "https://n.test", fetch: withId.fetch, retry: { baseDelayMs: 0 } }).indexDocument(
      "i",
      { x: 1 },
      { id: "a" },
    );
    expect(withId.calls).toHaveLength(2);

    const withKey = mockFetch(unavailable, reply({ _id: "z", ack: "accepted" }, 201));
    await new GnarlClient({ url: "https://n.test", fetch: withKey.fetch, retry: { baseDelayMs: 0 } }).indexDocument(
      "i",
      { x: 1 },
      { idempotencyKey: "k" },
    );
    expect(withKey.calls).toHaveLength(2);

    const bare = mockFetch(unavailable, reply({}));
    await expect(
      new GnarlClient({ url: "https://n.test", fetch: bare.fetch, retry: { baseDelayMs: 0 } }).indexDocument("i", { x: 1 }),
    ).rejects.toBeInstanceOf(UnavailableError);
    expect(bare.calls).toHaveLength(1);
  });

  it("retries bulk only when every document has an _id", async () => {
    const all = mockFetch(unavailable, reply({ items: [], errors: false, ack: "accepted" }));
    await new GnarlClient({ url: "https://n.test", fetch: all.fetch, retry: { baseDelayMs: 0 } }).bulk("i", [{ _id: "a" }, { _id: "b" }]);
    expect(all.calls).toHaveLength(2);

    const some = mockFetch(unavailable, reply({}));
    await expect(
      new GnarlClient({ url: "https://n.test", fetch: some.fetch, retry: { baseDelayMs: 0 } }).bulk("i", [{ _id: "a" }, { x: 1 }]),
    ).rejects.toBeInstanceOf(UnavailableError);
    expect(some.calls).toHaveLength(1);
  });

  it("retries a search (a read, though it is a POST) and not a memory write", async () => {
    const s = mockFetch(
      rateLimited("0"),
      reply({ hits: { hits: [] }, coverage: { served_claims: 1, expected_claims: 1, skipped_claims: [] } }),
    );
    await new GnarlClient({ url: "https://n.test", fetch: s.fetch }).search("i");
    expect(s.calls).toHaveLength(2);

    const r = mockFetch(rateLimited("0"), reply({}));
    await expect(new GnarlClient({ url: "https://n.test", fetch: r.fetch }).memory.remember({ content: "x" })).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(r.calls).toHaveLength(1);
  });
});

describe("no response at all", () => {
  it("wraps a network failure in ConnectionError with status 0 and the cause", async () => {
    const boom = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const c = new GnarlClient({
      url: "https://n.test",
      fetch: async () => {
        throw boom;
      },
    });
    const err = await failure(c.ping());
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.status).toBe(0);
    expect(err.type).toBe("connection_error");
    expect(err.message).toMatch(/ECONNREFUSED/);
    expect(err.cause).toBe(boom);
  });

  it("times out an attempt with ConnectionError type timeout", async () => {
    const hang = (_u: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const c = new GnarlClient({ url: "https://n.test", fetch: hang, timeoutMs: 20 });
    const err = await failure(c.status());
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.type).toBe("timeout");
  });

  it("rethrows the caller's own abort reason untouched", async () => {
    const hang = (_u: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const c = new GnarlClient({ url: "https://n.test", fetch: hang });
    const ac = new AbortController();
    const reason = new Error("navigated away");
    const p = c.status({ signal: ac.signal });
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
  });

  it("does not start a request whose signal already fired", async () => {
    const m = mockFetch(reply({}));
    const c = new GnarlClient({ url: "https://n.test", fetch: m.fetch });
    const ac = new AbortController();
    ac.abort(new Error("early"));
    await expect(c.status({ signal: ac.signal })).rejects.toThrow("early");
    expect(m.calls).toHaveLength(0);
  });

  it("explains a missing fetch instead of failing later", () => {
    vi.stubGlobal("fetch", undefined);
    try {
      expect(() => new GnarlClient({ url: "https://n.test" })).toThrow(/no global fetch/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("text/plain errors", () => {
  it("maps the framework's 422 to ValidationError with the text as reason", async () => {
    const m = mockFetch({ status: 422, text: "Failed to deserialize the JSON body into the target type: query: unknown variant `bogus`" });
    const err = await failure(new GnarlClient({ url: "https://n.test", fetch: m.fetch }).search("i", {}));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.type).toBe("");
    expect(err.status).toBe(422);
    expect(err.reason).toMatch(/unknown variant/);
  });
});
