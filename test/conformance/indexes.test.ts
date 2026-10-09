/**
 * The quick start and the index/document/search surface, against a real node.
 */

import { describe, expect, it } from "vitest";
import { AlreadyExistsError, failedItems, type GnarlError, NotFoundError, UnsupportedError, ValidationError } from "../../src/index.js";
import { client, noNode, tempIndex, uniqueName, until } from "./harness.js";

interface Place {
  name: string;
  country: string;
  population: number;
}

const placeSchema = {
  fields: {
    name: { type: "text" as const },
    country: { type: "keyword" as const },
    population: { type: "long" as const },
  },
};

describe.skipIf(noNode)("quick start", () => {
  const c = client();

  it("creates an index, writes documents, searches and reads them back", async () => {
    const name = await tempIndex(c, placeSchema, "qs");

    const meta = await c.getIndex(name);
    expect(meta.name).toBe(name);
    expect(meta.claim_count).toBeGreaterThanOrEqual(1);
    // The public engine names: `native` (built in) or `lucene` (JVM).
    expect(["native", "lucene"]).toContain(meta.engine_binding);
    expect(await c.indexExists(name)).toBe(true);
    expect(await c.getSchema(name)).toMatchObject({ fields: { name: { type: "text" }, population: { type: "long" } } });

    const one = await c.indexDocument(
      name,
      { name: "Sydney Harbour", country: "AU", population: 5_450_000 },
      { id: "sydney", waitFor: "visible" },
    );
    expect(one).toMatchObject({ _id: "sydney", ack: "visible_for_search" });

    const many = await c.bulk(
      name,
      [
        { _id: "lisbon", name: "Lisbon", country: "PT", population: 545_000 },
        { _id: "porto", name: "Porto", country: "PT", population: 232_000 },
      ],
      { waitFor: "visible" },
    );
    expect(many.errors).toBe(false);
    expect(many.items.map((i) => [i._id, i.status])).toEqual([
      ["lisbon", 201],
      ["porto", 201],
    ]);

    const byTerm = await c.search<Place>(name, { query: { term: { country: "PT" } } });
    expect(byTerm.hits.hits.map((h) => h._id).sort()).toEqual(["lisbon", "porto"]);
    expect(byTerm.partial).toBe(false);
    expect(byTerm.coverage.served_claims).toBe(byTerm.coverage.expected_claims);

    const byText = await c.search<Place>(name, { query: { match: { name: "harbour" } } }, { requireComplete: true });
    expect(byText.hits.hits[0]?._id).toBe("sydney");
    expect(byText.hits.hits[0]?._source?.population).toBe(5_450_000);

    const doc = await c.getDocument<Place>(name, "lisbon");
    expect(doc).toEqual({ _id: "lisbon", _source: { name: "Lisbon", country: "PT", population: 545_000 } });

    const counted = await c.count(name);
    expect(typeof counted.partial).toBe("boolean");
    // A count is this node's slice and, when partial, a floor.
    expect(counted.count).toBeGreaterThanOrEqual(counted.partial ? 0 : 3);
  });

  it("acknowledges a delete durably, and the document becomes unreadable soon after", async () => {
    const name = await tempIndex(c, placeSchema, "del");
    await c.indexDocument(name, { name: "Gone", country: "XX", population: 1 }, { id: "gone", waitFor: "visible" });
    await c.deleteDocument(name, "gone");
    const vanished = await until(async () => {
      try {
        await c.getDocument(name, "gone");
        return false;
      } catch (err) {
        return err instanceof NotFoundError && err.type === "document_not_found";
      }
    });
    expect(vanished).toBe(true);
  });

  it("deletes an index", async () => {
    const name = uniqueName("drop");
    await c.createIndex(name, placeSchema);
    await c.deleteIndex(name);
    expect(await c.indexExists(name)).toBe(false);
  });
});

describe.skipIf(noNode)("errors from a real node", () => {
  const c = client();

  it("index_not_found", async () => {
    const err = (await c.getIndex(uniqueName("nope")).catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.type).toBe("index_not_found");
    expect(err.status).toBe(404);
    expect(err.reason).not.toBe("");
  });

  it("document_not_found, distinct from index_not_found", async () => {
    const name = await tempIndex(c, placeSchema, "dnf");
    const err = (await c.getDocument(name, "atlantis").catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.type).toBe("document_not_found");
  });

  it("index_already_exists", async () => {
    const name = await tempIndex(c, placeSchema, "dup");
    const err = (await c.createIndex(name, placeSchema).catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(AlreadyExistsError);
    expect(err.type).toBe("index_already_exists");
    expect(err.status).toBe(409);
  });

  it("validation_error for a reserved field name", async () => {
    const err = (await c.createIndex(uniqueName("reserved"), { fields: { title: { type: "text" } } }).catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.type).toBe("validation_error");
    expect(err.status).toBe(400);
  });

  it("the framework's text/plain 422 for a body that does not deserialize", async () => {
    const name = await tempIndex(c, placeSchema, "422");
    const err = (await c.search(name, { query: { bogus: {} } as never }).catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(422);
    expect(err.type).toBe("");
    expect(err.reason).toMatch(/unknown variant `bogus`/);
  });

  it("unsupported_capability for a query the field cannot answer", async () => {
    const name = await tempIndex(c, placeSchema, "cap");
    const err = (await c.search(name, { query: { match: { population: "5" } } }).catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(UnsupportedError);
    expect(err.type).toBe("unsupported_capability");
  });

  it("an unknown /v1 route is a NotFoundError", async () => {
    // The description promises `route_not_found` here. A --headless node
    // (what this harness runs) mounts no fallback and answers a BODYLESS 404,
    // so the type is not asserted — only what the client guarantees.
    const err = (await c.request("GET", "/v1/no-such-route").catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(["", "route_not_found"]).toContain(err.type);
  });

  it("a bulk item that fails validation costs that item, not the batch", async () => {
    const name = await tempIndex(c, placeSchema, "bulkfail");
    const res = await c.bulk(name, [
      { _id: "ok", name: "Fine", country: "AU", population: 1 },
      { _id: "bad", name: "Nope", country: "AU", population: "lots" },
    ]);
    expect(res.errors).toBe(true);
    const failed = failedItems(res);
    expect(failed.map((i) => i._id)).toEqual(["bad"]);
    expect(failed[0]?.status).toBe(400);
    expect(failed[0]?.error?.type).toBe("validation_error");
  });
});

describe.skipIf(noNode)("listing, paging and bulk helpers", () => {
  const c = client();

  it("listIndexes follows the cursor across pages", async () => {
    const a = await tempIndex(c, placeSchema, "list");
    const b = await tempIndex(c, placeSchema, "list");
    const firstPage = await c.listIndexesPage({ limit: 1 });
    expect(firstPage.indexes).toHaveLength(1);
    expect(typeof firstPage.next_after).toBe("string");
    const all: string[] = [];
    for await (const idx of c.listIndexes({ limit: 1 })) all.push(idx.name);
    expect(all).toEqual(expect.arrayContaining([a, b]));
    expect(new Set(all).size).toBe(all.length);
  });

  it("searchAfter walks every hit exactly once, in sort order", async () => {
    const name = await tempIndex(c, placeSchema, "walk");
    const docs = Array.from({ length: 25 }, (_, i) => ({ _id: `p${i}`, name: `Place ${i}`, country: "XX", population: i * 10 }));
    const res = await c.bulk(name, docs, { waitFor: "visible" });
    expect(failedItems(res)).toEqual([]);
    const seen: number[] = [];
    for await (const hit of c.searchAfter<Place>(name, { query: { match_all: {} }, sort: [{ population: { order: "asc" } }], size: 7 })) {
      seen.push(hit._source?.population as number);
    }
    expect(seen).toEqual(docs.map((d) => d.population));
  });

  it("bulkChunked reports offsets that map items back to input positions", async () => {
    const name = await tempIndex(c, placeSchema, "chunk");
    async function* source() {
      for (let i = 0; i < 9; i++) yield { _id: `c${i}`, name: `C${i}`, country: "XX", population: i === 7 ? "bad" : i };
    }
    const failedPositions: number[] = [];
    let chunks = 0;
    for await (const { offset, response } of c.bulkChunked(name, source(), { chunkSize: 4, waitFor: "visible" })) {
      chunks++;
      response.items.forEach((item, i) => {
        if (item.error) failedPositions.push(offset + i);
      });
    }
    expect(chunks).toBe(3);
    expect(failedPositions).toEqual([7]);
    const hits = await c.search(name, { query: { match_all: {} }, size: 20 });
    expect(hits.hits.hits).toHaveLength(8);
  });

  it("bulkStream sends NDJSON from a generator and reports per-item status", async () => {
    const name = await tempIndex(c, placeSchema, "ndjson");
    function* gen() {
      for (let i = 0; i < 12; i++) yield { _id: `s${i}`, name: `S${i}`, country: "XX", population: i };
    }
    const res = await c.bulkStream(name, gen(), { waitFor: "durable" });
    expect(res.errors).toBe(false);
    expect(res.items).toHaveLength(12);
    expect(res.items.map((i) => i.seq)).toEqual([...Array(12).keys()]);
    expect(res.items.every((i) => i.status === 201 || i.status === 200)).toBe(true);
    const visible = await until(async () => (await c.search(name, { query: { match_all: {} }, size: 20 })).hits.hits.length === 12);
    expect(visible).toBe(true);
  });

  it("policy: read, narrow, read back", async () => {
    const name = await tempIndex(c, placeSchema, "policy");
    expect(await c.getPolicy(name)).toMatchObject({ placement: "mesh" });
    expect(await c.putPolicy(name, { placement: "local" })).toMatchObject({ placement: "local" });
    expect(await c.getPolicy(name)).toMatchObject({ placement: "local" });
  });

  it("forcemerge merges the local claims", async () => {
    const name = await tempIndex(c, placeSchema, "merge");
    // Enough documents that every claim has an engine. On a FRESH index with
    // a claim that never received a write, the node answers 500 "no engine
    // for local claim" — a server defect, reported, not exercised here.
    const docs = Array.from({ length: 40 }, (_, i) => ({ _id: `m${i}`, name: `M${i}`, country: "XX", population: i }));
    await c.bulk(name, docs, { waitFor: "visible" });
    const res = await c.forcemerge(name, { maxNumSegments: 1 });
    expect(typeof res.segments).toBe("number");
    expect(res.partial).toBe(false);
  });
});
