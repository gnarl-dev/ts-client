// Loads the BUILT package through its `exports` map, as ESM, on whatever Node
// runs this — CI runs it on 18, the floor the package claims. No node needed:
// the request goes to a stub fetch.
import assert from "node:assert/strict";
import { GnarlClient, GnarlError, NotFoundError, VERSION } from "gnarl-client";

let seen;
const client = new GnarlClient({
  url: "https://node.test",
  fetch: async (url, init) => {
    seen = { url, method: init.method };
    return new Response(JSON.stringify({ error: { type: "index_not_found", reason: "no" } }), { status: 404 });
  },
});
const err = await client.getIndex("x").catch((e) => e);
assert.ok(err instanceof NotFoundError);
assert.ok(GnarlError.is(err));
assert.equal(err.type, "index_not_found");
assert.deepEqual(seen, { url: "https://node.test/v1/indexes/x", method: "GET" });
assert.match(VERSION, /^\d+\.\d+\.\d+/);
console.log(`esm ok on node ${process.version}`);
