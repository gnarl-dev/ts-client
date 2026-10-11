/**
 * Agent memory against a real node: what is remembered can be recalled.
 */

import { describe, expect, it } from "vitest";
import { type GnarlError, ValidationError } from "../../src/index.js";
import { client, noNode, uniqueName, until } from "./harness.js";

describe.skipIf(noNode)("memory", () => {
  const c = client();
  // A user per run, so recall cannot be satisfied by an earlier run's memory.
  const user = uniqueName("u");

  it("remember -> recall returns the memory, scoped to its user", async () => {
    const content = `The ${user} team deploys on Thursdays and never on Fridays`;
    const stored = await c.memory.remember({ content, user, fact_type: "preference", tags: { source: "conformance" } });
    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.user).toBe(user);
    expect(stored.embedder).not.toBe("");

    let recalled = await c.memory.recall({ query: "which day does the team deploy?", user, k: 5 });
    const found = await until(async () => {
      recalled = await c.memory.recall({ query: "which day does the team deploy?", user, k: 5 });
      return recalled.memories.some((m) => m.id === stored.id);
    });
    expect(found).toBe(true);
    const memory = recalled.memories.find((m) => m.id === stored.id);
    expect(memory?.content).toBe(content);
    expect(typeof memory?.score).toBe("number");
    expect(recalled.count).toBe(recalled.memories.length);
    // Tags come back flattened to a "k=v,k=v" STRING, as documented.
    expect(typeof memory?.tags).toBe("string");
    expect(memory?.tags).toContain("source=conformance");

    const stranger = await c.memory.recall({ query: "which day does the team deploy?", user: uniqueName("other"), k: 5 });
    expect(stranger.memories.some((m) => m.id === stored.id)).toBe(false);
  });

  it("recall on a namespace nothing was written to is an empty answer, not an error", async () => {
    const namespace = uniqueName("never-written");
    const r = await c.memory.recall({ query: "is anything here?", namespace });
    expect(r.count).toBe(0);
    expect(r.memories).toEqual([]);
    // Older nodes omit it on this path; the client fills it in either way.
    expect(typeof r.embedder).toBe("string");
  });

  it("answer composes over recalled memories", async () => {
    const content = `${user} keeps the spare office key in the blue drawer`;
    const stored = await c.memory.remember({ content, user });
    const answered = await until(async () => {
      const res = await c.memory.answer({ query: "where is the spare office key?", user, k: 3 });
      return JSON.stringify(res).includes(stored.id);
    });
    expect(answered).toBe(true);
  });

  it("bootstrap answers (the server requires a JSON body the description omits)", async () => {
    const res = await c.memory.bootstrap();
    expect(res).toBeTypeOf("object");
    expect(res.active).toBe(true);
  });

  it("an empty memory is refused as a validation error", async () => {
    const err = (await c.memory.remember({ content: "", user }).catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
  });

  it("ingestMessages stores a transcript that recall can find", async () => {
    const marker = uniqueName("thread");
    const res = await c.memory.ingestMessages({
      messages: [
        { role: "me", body: `Booked the ${marker} venue for the offsite`, ts_ms: Date.now() },
        { role: "them", body: "Great, I will send the invites" },
      ],
      user,
      thread_title: marker,
    });
    expect(res).toBeTypeOf("object");
    const found = await until(async () => {
      const r = await c.memory.recall({ query: `${marker} venue offsite`, user, k: 10 });
      return r.memories.some((m) => m.content.includes(marker));
    });
    expect(found).toBe(true);
  });
});
