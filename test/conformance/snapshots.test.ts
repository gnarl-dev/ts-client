/**
 * Repository -> snapshot -> job -> descriptor -> schedule -> cleanup, against
 * a real node and a real directory.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type GnarlError, NotFoundError } from "../../src/index.js";
import { client, nodeBinary, noNode, tempIndex, uniqueName } from "./harness.js";

// A filesystem repository must be a path the NODE can write, which is only
// knowable when this harness started the node on this machine.
describe.skipIf(noNode || nodeBinary === "")("snapshots", () => {
  const c = client();
  const dir = mkdtempSync(join(tmpdir(), "gnarl-ts-repo-"));
  const repo = uniqueName("repo");
  const snap = uniqueName("snap");
  afterAll(async () => {
    await c.snapshots.unregisterRepository(repo).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers a filesystem repository", async () => {
    const reg = await c.snapshots.registerRepository(repo, { type: "fs", location: dir });
    expect(reg).toMatchObject({ repository: repo, spec: { type: "fs", location: dir, encrypted: false } });
    expect((await c.snapshots.getRepository(repo)).repository).toBe(repo);
    const all = await c.snapshots.listRepositories();
    expect(all.repositories?.map((r) => r.repository)).toContain(repo);
  });

  it("snapshots an index, and the job, listing and signed descriptor agree", async () => {
    const index = await tempIndex(c, { fields: { name: { type: "text" }, n: { type: "integer" } } }, "snapsrc");
    await c.bulk(
      index,
      Array.from({ length: 10 }, (_, i) => ({ _id: `d${i}`, name: `doc ${i}`, n: i })),
      { waitFor: "visible" },
    );

    const started = await c.snapshots.create(repo, snap, { index });
    expect(started).toMatchObject({ kind: "snapshot", repository: repo, snapshot: snap });
    const job = await c.snapshots.waitForJob(started.id as string, { intervalMs: 100, deadlineMs: 60_000 });
    expect(job.state).toBe("succeeded");
    expect((await c.snapshots.listJobs()).jobs?.some((j) => j.id === job.id)).toBe(true);

    expect((await c.snapshots.list(repo)).snapshots).toContain(snap);
    const descriptor = await c.snapshots.get(repo, snap);
    expect(descriptor.snapshot).toBe(snap);
    expect(descriptor.index_name).toBe(index);
    expect(descriptor.signature_verified).toBe(true);
    expect(descriptor.claims?.reduce((n, cl) => n + (cl.doc_count ?? 0), 0)).toBe(10);
  });

  it("schedules, reads and clears a backup schedule", async () => {
    expect(await c.snapshots.getSchedule(repo)).toEqual({ repository: repo, schedule: null });
    const set = await c.snapshots.setSchedule(repo, { target: "anything", everyHours: 24, prefix: "nightly" });
    expect(set.schedule).toMatchObject({ target: "anything", everyHours: 24, prefix: "nightly", enabled: true });
    expect((await c.snapshots.getSchedule(repo)).schedule).toMatchObject({ everyHours: 24 });
    expect(await c.snapshots.clearSchedule(repo)).toEqual({ repository: repo, removed: true });
  });

  it("deletes the snapshot and cleans the repository", async () => {
    expect(await c.snapshots.delete(repo, snap)).toMatchObject({ snapshot: snap, deleted: true });
    expect((await c.snapshots.list(repo)).snapshots).not.toContain(snap);
    const cleanup = await c.snapshots.cleanupRepository(repo, { grace_seconds: 0 });
    const done = await c.snapshots.waitForJob(cleanup.id as string, { intervalMs: 100, deadlineMs: 60_000 });
    expect(done.state).toBe("succeeded");
  });

  it("an unknown repository is a NotFoundError of type repository_not_found", async () => {
    const err = (await c.snapshots.getRepository(uniqueName("missing")).catch((e) => e)) as GnarlError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.type).toBe("repository_not_found");
  });
});
