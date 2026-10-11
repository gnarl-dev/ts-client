/**
 * `new GnarlClient()` finds the node on this machine: explicit url →
 * $GNARL_URL → the endpoint.json the node recorded → http://127.0.0.1:43300.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endpointUrl, isLoopbackHost, LOCAL_DEFAULT_URL } from "../../src/discover.js";
import { GnarlClient } from "../../src/index.js";
import { mockFetch } from "./mock.js";

let scratch: string;
let dataDir: string;
let home: string;

function record(dir: string, body: unknown): void {
  mkdirSync(join(dir, "runtime"), { recursive: true });
  writeFileSync(join(dir, "runtime", "endpoint.json"), typeof body === "string" ? body : JSON.stringify(body));
}
const ep = (scheme: string, host: string, port: number) => ({ scheme, host, port, pid: 4242 });
const url = (opts: { url?: string } = {}) => new GnarlClient({ fetch: mockFetch().fetch, ...opts }).url;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "gnarl-discover-"));
  dataDir = join(scratch, "data");
  home = join(scratch, "home");
  mkdirSync(home);
  vi.stubEnv("GNARL_URL", "");
  vi.stubEnv("LUCENIA_DATA_DIR", dataDir);
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("new GnarlClient() with no url", () => {
  it("defaults to the Gnarly app on loopback when nothing is recorded", () => {
    expect(LOCAL_DEFAULT_URL).toBe("http://127.0.0.1:43300");
    expect(url()).toBe("http://127.0.0.1:43300");
  });

  it("uses the endpoint recorded under $LUCENIA_DATA_DIR", () => {
    record(dataDir, ep("http", "127.0.0.1", 52001));
    expect(url()).toBe("http://127.0.0.1:52001");
  });

  it("falls back to ~/.lucenia when $LUCENIA_DATA_DIR has no record", () => {
    record(join(home, ".lucenia"), ep("http", "localhost", 52002));
    expect(url()).toBe("http://localhost:52002");
  });

  it("prefers $LUCENIA_DATA_DIR over ~/.lucenia", () => {
    record(dataDir, ep("http", "127.0.0.1", 52003));
    record(join(home, ".lucenia"), ep("http", "127.0.0.1", 52004));
    expect(url()).toBe("http://127.0.0.1:52003");
  });

  it("reads only ~/.lucenia when $LUCENIA_DATA_DIR is unset", () => {
    vi.stubEnv("LUCENIA_DATA_DIR", "");
    record(join(home, ".lucenia"), ep("http", "127.0.0.1", 52005));
    expect(url()).toBe("http://127.0.0.1:52005");
  });

  it("lets $GNARL_URL win over a recorded endpoint", () => {
    record(dataDir, ep("http", "127.0.0.1", 52006));
    vi.stubEnv("GNARL_URL", "https://env.test");
    expect(url()).toBe("https://env.test");
  });

  it("lets an explicit url win over both, and never downgrades it", () => {
    record(dataDir, ep("http", "127.0.0.1", 52007));
    vi.stubEnv("GNARL_URL", "http://127.0.0.1:1");
    expect(url({ url: "https://node.example.com" })).toBe("https://node.example.com");
    expect(url({ url: "node.example.com" })).toBe("https://node.example.com");
  });

  it("skips a plain-HTTP record for a host off this machine, and keeps looking", () => {
    record(dataDir, ep("http", "10.0.0.5", 52008));
    record(join(home, ".lucenia"), ep("http", "127.0.0.1", 52009));
    expect(url()).toBe("http://127.0.0.1:52009");
  });

  it("never downgrades: plain HTTP off loopback falls through to the default", () => {
    record(dataDir, ep("http", "192.168.1.20", 52010));
    expect(url()).toBe("http://127.0.0.1:43300");
  });

  it("accepts an https record for any host", () => {
    record(dataDir, ep("https", "node.lan", 52011));
    expect(url()).toBe("https://node.lan:52011");
  });

  it("skips a file that is not JSON, and keeps looking", () => {
    record(dataDir, "{not json");
    record(join(home, ".lucenia"), ep("https", "127.0.0.1", 52012));
    expect(url()).toBe("https://127.0.0.1:52012");
  });

  it("brackets an IPv6 loopback", () => {
    record(dataDir, ep("http", "::1", 52013));
    expect(url()).toBe("http://[::1]:52013");
  });
});

describe("endpointUrl", () => {
  it("refuses what is not a usable endpoint", () => {
    for (const bad of [
      "null",
      "[]",
      JSON.stringify(ep("ftp", "127.0.0.1", 1)),
      JSON.stringify(ep("http", "", 1)),
      JSON.stringify(ep("http", "127.0.0.1", 0)),
      JSON.stringify(ep("http", "127.0.0.1", 65536)),
      JSON.stringify(ep("http", "127.0.0.1", 1.5)),
      JSON.stringify({ scheme: "http", host: "127.0.0.1", port: "43300" }),
      JSON.stringify(ep("http", "example.com", 43300)),
      JSON.stringify(ep("http", "127.example.com", 43300)),
    ]) {
      expect(endpointUrl(bad), bad).toBeUndefined();
    }
  });
  it("knows loopback", () => {
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "LOCALHOST"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["10.0.0.1", "128.0.0.1", "127.0.0.256", "::2", "localhost.evil.test", ""]) expect(isLoopbackHost(h), h).toBe(false);
  });
});

describe("browser and edge bundles", () => {
  it("no source module imports a Node built-in", () => {
    // Discovery reads files through process.getBuiltinModule at run time, so
    // a bundler for the browser or an edge worker never sees `fs`.
    const src = resolve(__dirname, "../../src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          const text = readFileSync(p, "utf8");
          if (/(from|import)\s*\(?\s*["'](node:|fs["']|os["']|path["'])|require\(\s*["']/.test(text)) offenders.push(p);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
