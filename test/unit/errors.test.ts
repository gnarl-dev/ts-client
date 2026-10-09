import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AlreadyExistsError,
  ConflictError,
  ConnectionError,
  type ErrorType,
  errorFromResponse,
  ForbiddenError,
  GnarlError,
  IncompleteResultError,
  InternalError,
  NotFoundError,
  parseRetryAfter,
  RateLimitedError,
  UnauthenticatedError,
  UnavailableError,
  UnsupportedError,
  ValidationError,
} from "../../src/index.js";

const envelope = (type: string, reason = "why", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ error: { type, reason, ...extra } });

// Every type in the description's ErrorType enum, and the class it must map to.
const expected: Record<ErrorType, new (...args: never[]) => GnarlError> = {
  validation_error: ValidationError,
  unsupported_capability: UnsupportedError,
  unsupported_engine: UnsupportedError,
  index_not_found: NotFoundError,
  document_not_found: NotFoundError,
  route_not_found: NotFoundError,
  index_already_exists: AlreadyExistsError,
  field_not_found: NotFoundError,
  schema_error: ValidationError,
  unauthorized: UnauthenticatedError,
  internal_error: InternalError,
  rate_limited: RateLimitedError,
  unauthenticated: UnauthenticatedError,
  forbidden: ForbiddenError,
  repository_not_found: NotFoundError,
  snapshot_not_found: NotFoundError,
  repository_error: InternalError,
  shared_pool: ValidationError,
  namespace_not_snapshottable: UnsupportedError,
  job_in_progress: ConflictError,
  unverified_signer: ConflictError,
};

describe("every ErrorType in the description maps to a class", () => {
  it("covers the enum exactly as vendored", () => {
    const spec = readFileSync(new URL("../../spec/openapi.yaml", import.meta.url), "utf8");
    const block = spec.slice(spec.indexOf("    ErrorBody:"), spec.indexOf("        reason:", spec.indexOf("    ErrorBody:")));
    const fromSpec = [...block.matchAll(/^ {12}- ([a-z_]+)$/gm)].map((m) => m[1]).sort();
    expect(fromSpec.length).toBeGreaterThan(15);
    expect(Object.keys(expected).sort()).toEqual(fromSpec);
  });

  for (const [type, Cls] of Object.entries(expected)) {
    it(type, () => {
      const err = errorFromResponse(418, envelope(type, `reason for ${type}`, { detail: { field: "f" } }), null, "GET /v1/x");
      expect(err).toBeInstanceOf(Cls);
      expect(err).toBeInstanceOf(GnarlError);
      expect(err).toBeInstanceOf(Error);
      expect(err.type).toBe(type);
      expect(err.reason).toBe(`reason for ${type}`);
      expect(err.status).toBe(418);
      expect(err.detail).toEqual({ field: "f" });
      expect(err.request).toBe("GET /v1/x");
      expect(err.name).toBe(Cls.name);
      expect(err.message).toBe(`${type}: reason for ${type} [GET /v1/x]`);
    });
  }
});

describe("bodies that are not the envelope", () => {
  it.each([
    [400, ValidationError],
    [401, UnauthenticatedError],
    [403, ForbiddenError],
    [404, NotFoundError],
    [409, ConflictError],
    [422, ValidationError],
    [429, RateLimitedError],
    [500, InternalError],
    [503, UnavailableError],
    [502, GnarlError],
  ] as const)("status %i falls back to %o with an empty type", (status, Cls) => {
    const err = errorFromResponse(status, "proxy says no");
    expect(err.constructor).toBe(Cls);
    expect(err.type).toBe("");
    expect(err.reason).toBe("proxy says no");
    expect(err.status).toBe(status);
  });

  it("handles a bodyless 404 (what a --headless node answers for an unknown path)", () => {
    const err = errorFromResponse(404, "");
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe("error (HTTP 404)");
  });

  it("treats `error` as a string as not-the-envelope rather than crashing", () => {
    const err = errorFromResponse(400, JSON.stringify({ error: "household_disabled: enable it" }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.type).toBe("");
  });

  it("truncates a huge non-JSON body", () => {
    const err = errorFromResponse(500, "x".repeat(5000));
    expect(err.reason.length).toBeLessThan(600);
  });

  it("keeps an unknown wire type rather than remapping it, falling back to status for the class", () => {
    const err = errorFromResponse(409, envelope("brand_new_type"));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.type).toBe("brand_new_type");
    const bare = errorFromResponse(418, envelope("brand_new_type"));
    expect(bare.constructor).toBe(GnarlError);
  });

  it("reads the deprecated `message` alias only when `reason` is absent", () => {
    expect(errorFromResponse(400, JSON.stringify({ error: { type: "validation_error", message: "old" } })).reason).toBe("old");
    expect(errorFromResponse(400, JSON.stringify({ error: { type: "validation_error", reason: "new", message: "old" } })).reason).toBe(
      "new",
    );
  });
});

describe("Retry-After", () => {
  it("parses delta-seconds and HTTP-dates, and ignores junk", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter("1.5")).toBe(1.5);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("-1")).toBeUndefined();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10);
    expect(parseRetryAfter("Wed, 31 Dec 2025 00:00:00 GMT", now)).toBe(0);
  });

  it("rides on the error", () => {
    const err = errorFromResponse(429, envelope("rate_limited"), "7");
    expect(err.retryAfter).toBe(7);
    expect(err.retryAfterOr(1)).toBe(7);
    expect(errorFromResponse(429, envelope("rate_limited")).retryAfterOr(1)).toBe(1);
  });
});

describe("GnarlError.is", () => {
  it("recognises every subclass and nothing else", () => {
    expect(GnarlError.is(new NotFoundError())).toBe(true);
    expect(GnarlError.is(new ConnectionError({ type: "timeout" }))).toBe(true);
    expect(GnarlError.is(new Error("x"))).toBe(false);
    expect(GnarlError.is(null)).toBe(false);
    expect(GnarlError.is("x")).toBe(false);
  });

  it("recognises an error from another copy of the class (the dual-package hazard)", () => {
    const foreign = new Error("from the other build");
    Object.defineProperty(foreign, Symbol.for("@gnarl/client.GnarlError"), { value: true });
    expect(GnarlError.is(foreign)).toBe(true);
  });
});

describe("IncompleteResultError", () => {
  it("carries the response and says what fell short", () => {
    const res = { partial: true };
    const err = new IncompleteResultError(res, 3, 4, 1);
    expect(err.response).toBe(res);
    expect(err.type).toBe("incomplete");
    expect(err.reason).toBe("3 of 4 claims answered, 1 skipped (requireComplete was set)");
    expect(err.name).toBe("IncompleteResultError");
  });
});
