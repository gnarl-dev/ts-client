/**
 * A recording `fetch` double. Each call is captured — method, URL, headers and
 * the body as the server would receive it — and answered from a queue.
 */

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export interface Call {
  method: string;
  url: URL;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** The body decoded as text, or undefined when none was sent. */
  bodyText: string | undefined;
  /** `bodyText` parsed as JSON when it is JSON. */
  body: unknown;
  /** Whether the body was handed to fetch as a stream. */
  streamed: boolean;
}

export type Responder = Reply | ((call: Call) => Reply);

export function reply(json: unknown, status = 200, headers: Record<string, string> = {}): Reply {
  return { status, json, headers };
}

export function mockFetch(...queue: Responder[]) {
  const calls: Call[] = [];
  const pending = [...queue];
  const fetch = async (input: string, init: RequestInit & { duplex?: string } = {}): Promise<Response> => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const streamed = init.body instanceof ReadableStream;
    if (streamed && init.duplex !== "half") throw new TypeError("a streamed body needs duplex: 'half'");
    const bodyText = init.body === undefined || init.body === null ? undefined : await new Response(init.body as BodyInit).text();
    let body: unknown = bodyText;
    if (bodyText !== undefined && headers["content-type"] === "application/json") body = JSON.parse(bodyText);
    const call: Call = {
      method: init.method ?? "GET",
      url,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      bodyText,
      body,
      streamed,
    };
    calls.push(call);
    const next = pending.length > 1 ? pending.shift() : pending[0];
    if (next === undefined) throw new Error(`unexpected request: ${call.method} ${call.path}`);
    const r = typeof next === "function" ? next(call) : next;
    const status = r.status ?? 200;
    const text = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
    const resHeaders = new Headers(r.headers);
    if (r.json !== undefined && !resHeaders.has("content-type")) resHeaders.set("content-type", "application/json");
    // 204/304 may not carry a body in the Response constructor.
    return new Response(status === 204 || status === 304 ? null : text, { status, headers: resHeaders });
  };
  return { fetch, calls };
}
