// The CommonJS half of smoke.mjs: `require` resolves the CJS build.
const assert = require("node:assert/strict");
const { GnarlClient, NotFoundError, GnarlError } = require("@gnarl/client");

const client = new GnarlClient({
  url: "https://node.test",
  fetch: async () => new Response(JSON.stringify({ error: { type: "document_not_found", reason: "no" } }), { status: 404 }),
});
client.getDocument("i", "d").then(
  () => assert.fail("expected a rejection"),
  (err) => {
    assert.ok(err instanceof NotFoundError);
    assert.ok(GnarlError.is(err));
    assert.equal(err.type, "document_not_found");
    console.log(`cjs ok on node ${process.version}`);
  },
);
