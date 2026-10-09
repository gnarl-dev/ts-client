/**
 * Small, dependency-free helpers that are useful with or without a client.
 */

import type { BulkIndexResponse, BulkItemResult, BulkStreamItem, BulkStreamResponse, Document } from "./types.js";

/**
 * The items of a bulk result that did not land.
 *
 * Bulk answers 200 with individual failures, so a caller who checks only the
 * HTTP status loses writes without seeing an error. This makes the check a
 * one-liner. Items are in request order, so an item's index is its document's.
 */
export function failedItems(result: BulkIndexResponse): BulkItemResult[];
export function failedItems(result: BulkStreamResponse): BulkStreamItem[];
export function failedItems(result: BulkIndexResponse | BulkStreamResponse): (BulkItemResult | BulkStreamItem)[] {
  // Read `errors` AND walk the items: the flag is the node's summary, the
  // per-item status is the fact.
  return (result.items as (BulkItemResult | BulkStreamItem)[]).filter(
    (item) => item.error !== undefined || item.status < 200 || item.status >= 300,
  );
}

/**
 * Merge a document with an optional `_id`. The wire shape puts fields at the
 * TOP LEVEL beside `_id`, so the id cannot be attached by nesting.
 */
export function documentBody(doc: Record<string, unknown>, id?: string): Document {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new TypeError(
      `gnarl: a document must be a plain object, got ${doc === null ? "null" : Array.isArray(doc) ? "an array" : typeof doc}`,
    );
  }
  if (id === undefined) return { ...doc };
  if (id === "") throw new TypeError("gnarl: empty document id (omit it to have one assigned)");
  return { ...doc, _id: id };
}

/**
 * Group any iterable — sync or async — into arrays of at most `size`.
 */
export async function* chunk<T>(items: Iterable<T> | AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("gnarl: chunk size must be a positive integer");
  let batch: T[] = [];
  for await (const item of items) {
    batch.push(item);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/** One NDJSON action/document pair: `{"index":{"_id":…}}` then the fields. */
export function ndjsonPair(doc: Record<string, unknown>): string {
  const { _id, ...fields } = doc as { _id?: unknown } & Record<string, unknown>;
  if (_id !== undefined && typeof _id !== "string") throw new TypeError("gnarl: _id must be a string");
  const action = _id === undefined ? { index: {} } : { index: { _id } };
  return `${JSON.stringify(action)}\n${JSON.stringify(fields)}\n`;
}

/**
 * Encode documents as the NDJSON body `_bulk_stream` reads, as a
 * `ReadableStream` produced lazily — a large or unbounded source is never held
 * in memory at once. A document's `_id`, when present, moves to its action line.
 */
export function toNdjson(docs: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const source = docs as Partial<AsyncIterable<Record<string, unknown>>> & Partial<Iterable<Record<string, unknown>>>;
  const it: AsyncIterator<Record<string, unknown>> | Iterator<Record<string, unknown>> =
    typeof source[Symbol.asyncIterator] === "function"
      ? (source as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]()
      : (source as Iterable<Record<string, unknown>>)[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await it.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(ndjsonPair(next.value)));
    },
    async cancel() {
      await it.return?.();
    },
  });
}
