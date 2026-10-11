/**
 * Finding the node on this machine when no URL was given.
 *
 * A node records where its Console answers in
 * `<data_dir>/runtime/endpoint.json` when it starts:
 *
 * ```json
 * { "scheme": "http", "host": "127.0.0.1", "port": 43300, "pid": 4242 }
 * ```
 *
 * The data directory is `$LUCENIA_DATA_DIR` when set, else `~/.lucenia` — the
 * same lookup the `gnarl` CLI makes. The file is a hint, not an authority: it
 * is read once at construction, never probed, and a missing, unreadable or
 * unsafe file is skipped. Plain HTTP is accepted from it ONLY on loopback, so
 * a file naming another host can never downgrade a request off this machine.
 *
 * Only Node (and runtimes that implement `process.getBuiltinModule`, like
 * Bun) read files. This module imports nothing from Node, so browser and edge
 * bundles never pull in `fs`; there the lookup simply finds nothing.
 */

/** The address of the Gnarly app's local node when nothing else names one. */
export const LOCAL_DEFAULT_URL = "http://127.0.0.1:43300";

interface FsLike {
  readFileSync(path: string, encoding: "utf8"): string;
}
interface OsLike {
  homedir(): string;
}

/** CommonJS's `module`, present only in the CJS build under Node. */
declare const module: { require?: (id: string) => unknown } | undefined;

type Proc = {
  env?: Record<string, string | undefined>;
  getBuiltinModule?: (id: string) => unknown;
};

/** A Node built-in, or `undefined` outside Node. Never a static import. */
function builtin<T>(id: string): T | undefined {
  try {
    const proc = (globalThis as { process?: Proc }).process;
    const viaProcess = proc?.getBuiltinModule?.(id);
    if (viaProcess) return viaProcess as T;
    // Node 18–20.15 lack getBuiltinModule. The CommonJS build still has
    // `module.require`; it is reached through `typeof` so that no bundler
    // sees a static require of fs to resolve.
    const mod = typeof module === "undefined" ? undefined : module;
    return mod?.require ? (mod.require(id) as T) : undefined;
  } catch {
    return undefined;
  }
}

function env(name: string): string | undefined {
  try {
    const value = (globalThis as { process?: Proc }).process?.env?.[name];
    return value === undefined || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

/** `localhost`, 127.0.0.0/8 or `::1`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const octets = h.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

/**
 * The base URL an `endpoint.json` body names, or `undefined` when it is not
 * one this client will use: malformed, an unknown scheme, a bad port, or plain
 * HTTP to a host that is not loopback.
 */
export function endpointUrl(text: string): string | undefined {
  let ep: unknown;
  try {
    ep = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof ep !== "object" || ep === null) return undefined;
  const { scheme, host, port } = ep as { scheme?: unknown; host?: unknown; port?: unknown };
  if (scheme !== "http" && scheme !== "https") return undefined;
  if (typeof host !== "string" || host.trim() === "") return undefined;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (scheme === "http" && !isLoopbackHost(host)) return undefined;
  const bare = host.replace(/^\[|\]$/g, "");
  const h = bare.includes(":") ? `[${bare}]` : bare;
  return `${scheme}://${h}:${port}`;
}

/** The `endpoint.json` files to try, most specific first. */
export function endpointFiles(): string[] {
  const files: string[] = [];
  const dataDir = env("LUCENIA_DATA_DIR");
  if (dataDir) files.push(`${dataDir}/runtime/endpoint.json`);
  let home: string | undefined;
  try {
    home = builtin<OsLike>("node:os")?.homedir();
  } catch {
    home = undefined;
  }
  if (home) files.push(`${home}/.lucenia/runtime/endpoint.json`);
  return files;
}

/** The URL the local node recorded, or `undefined` if there is no usable record. */
export function discoverLocalUrl(): string | undefined {
  const fs = builtin<FsLike>("node:fs");
  if (!fs) return undefined;
  for (const file of endpointFiles()) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const url = endpointUrl(text);
    if (url) return url;
  }
  return undefined;
}
