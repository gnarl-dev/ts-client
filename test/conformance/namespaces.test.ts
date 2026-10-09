/**
 * Namespaces against a real node: name one and write, and a search sees only
 * that namespace's documents.
 */

import { afterAll, describe, expect, it } from "vitest";
import { type GnarlError, NotFoundError } from "../../src/index.js";
import { client, noNode, uniqueName, until } from "./harness.js";

describe.skipIf(noNode)("namespaces", () => {
  const c = client();
  const a = uniqueName("ns-a");
  const b = uniqueName("ns-b");
  afterAll(async () => {
    await c.namespaces.delete(a).catch(() => undefined);
    await c.namespaces.delete(b).catch(() => undefined);
  });

  it("index -> search, isolated from another namespace", async () => {
    const written = await c.namespaces.indexDocument(a, { subject: "quarterly board pack", n: 1 }, { id: "doc-1", waitFor: "visible" });
    expect(written).toMatchObject({ _id: "doc-1", ack: "visible_for_search" });
    await c.namespaces.indexDocument(b, { subject: "quarterly offsite", n: 2 }, { id: "doc-1", waitFor: "visible" });

    const inA = await c.namespaces.search(a, { query: { match: { subject: "quarterly" } } }, { requireComplete: true });
    expect(inA.hits.hits).toHaveLength(1);
    expect(inA.hits.hits[0]?._source).toEqual({ subject: "quarterly board pack", n: 1 });

    const inB = await c.namespaces.search(b, { query: { match: { subject: "quarterly" } } });
    expect(inB.hits.hits.map((h) => h._source?.subject)).toEqual(["quarterly offsite"]);

    // The same _id in two namespaces is two documents.
    expect((await c.namespaces.getDocument(a, "doc-1"))._source).toMatchObject({ n: 1 });
    expect((await c.namespaces.getDocument(b, "doc-1"))._source).toMatchObject({ n: 2 });
  });

  it("bulk writes are per-item and land in the namespace", async () => {
    const res = await c.namespaces.bulk(
      a,
      [
        { _id: "doc-2", subject: "annual plan", n: 2 },
        { _id: "doc-3", subject: "annual review", n: 3 },
      ],
      { waitFor: "visible" },
    );
    expect(res.errors).toBe(false);
    expect(res.items.map((i) => i._id)).toEqual(["doc-2", "doc-3"]);
    const hits = await c.namespaces.search(a, { query: { match: { subject: "annual" } } });
    expect(hits.hits.hits.map((h) => h._id).sort()).toEqual(["doc-2", "doc-3"]);
  });

  it("searchAfter walks a namespace", async () => {
    const ids: string[] = [];
    for await (const hit of c.namespaces.searchAfter(a, { query: { match_all: {} }, sort: [{ n: { order: "asc" } }], size: 2 }))
      ids.push(hit._id);
    expect(ids).toEqual(["doc-1", "doc-2", "doc-3"]);
  });

  it("list includes the namespace with its promotion state", async () => {
    const seen = new Map<string, string>();
    for await (const ns of c.namespaces.list({ limit: 1 })) seen.set(ns.name, ns.promotion);
    expect(seen.get(a)).toBe("pooled");
    expect(seen.has(b)).toBe(true);
  });

  it("key status reports an unkeyed namespace", async () => {
    expect(await c.namespaces.keyStatus(a)).toMatchObject({ namespace: a, encrypted: false, unlocked: false });
  });

  it("deleteDocument is durable and the document goes away", async () => {
    await c.namespaces.deleteDocument(a, "doc-3");
    const gone = await until(async () => {
      try {
        await c.namespaces.getDocument(a, "doc-3");
        return false;
      } catch (err) {
        return err instanceof NotFoundError;
      }
    });
    expect(gone).toBe(true);
  });

  it("promote moves the namespace to a dedicated index without losing documents", async () => {
    const res = await c.namespaces.promote(a);
    expect(res).toMatchObject({ namespace: a });
    const dedicated = await until(async () => {
      for await (const ns of c.namespaces.list()) if (ns.name === a) return ns.promotion === "dedicated";
      return false;
    });
    expect(dedicated).toBe(true);
    const hits = await c.namespaces.search(a, { query: { match_all: {} }, size: 10 });
    expect(hits.hits.hits.map((h) => h._id).sort()).toEqual(["doc-1", "doc-2"]);
  });

  it("delete removes the namespace", async () => {
    const res = await c.namespaces.delete(b);
    expect(res).toMatchObject({ namespace: b });
    // Like a document delete, the erase is acknowledged before every read
    // stops seeing it — so poll rather than assert at once.
    const gone = await until(async () => {
      const err = (await c.namespaces.getDocument(b, "doc-1").catch((e) => e)) as GnarlError | { _id: string };
      return err instanceof NotFoundError;
    });
    expect(gone).toBe(true);
  });
});
