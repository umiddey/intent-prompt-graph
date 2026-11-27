import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config";
import { type Harness, harnessById, type SessionRef } from "./harness/harness";
import type { ServerEvent } from "./model";
import { openSession, type Session } from "./session";

export const APP = "intent-prompt-graph";
/**
 * `ipg stop` sends the daemon token in this header with POST /stop. A web page cannot add a custom
 * header to a cross-site request without a CORS preflight, which this server never approves.
 */
export const STOP_HEADER = "x-ipg-stop";
/** `ipg open` sends the daemon token in this header with POST /ticket. */
export const KEY_HEADER = "x-ipg-key";
/** A ticket opens the page once, within this time of being issued. */
const TICKET_MS = 120_000;
const NO_KEY = "This page needs a key. Run `ipg open --no-browser` in a terminal and use the link it prints.\n";
/** A session pipeline stops this long after its last SSE client leaves. */
const LINGER_MS = 60_000;
const PAGE = join(import.meta.dir, "../web/index.html");
const encoder = new TextEncoder();

interface Pipeline {
  session: Promise<Session>;
  clients: number;
  linger?: Timer;
}

export interface Daemon {
  readonly port: number;
  stop(): void;
}

/** What /health answers to a nonce: only a daemon that holds the token can compute it. */
export function healthProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(nonce).digest("hex");
}

/** Name of the cookie that holds the token; cookies are shared across ports, so the port is in the name. */
export function cookieName(port: number): string {
  return `ipg_${port}`;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieOf(req: Request, name: string): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

/**
 * Loopback HTTP daemon: the page, the SSE event stream, a health check, POST /ticket and POST /stop.
 * `onIdle` runs after the idle timeout, and after a stop request once the server has closed.
 *
 * Session content is served only to a browser that holds `token` in a cookie. `ipg open` gets the
 * cookie into the browser with a ticket: POST /ticket (token in a header) returns a random key
 * that the page URL carries as `?k=`; it works once, and the reply sets the cookie.
 */
export function startDaemon(opts: { config: Config; port: number; token: string; onIdle: () => void }): Daemon {
  const { config, token } = opts;
  /** Unused tickets and when they expire. */
  const tickets = new Map<string, number>();
  const pipelines = new Map<string, Pipeline>();
  let clients = 0;
  let idle: Timer | undefined;

  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(opts.onIdle, config.idleExitMinutes * 60_000);
    idle.unref();
  };
  armIdle();

  /** Returns the shared pipeline for a session, opening it on first use. */
  function pipelineFor(id: string, harness: Harness, ref: SessionRef): Pipeline {
    const have = pipelines.get(id);
    if (have) return have;
    const p: Pipeline = { session: openSession({ harness, ref, config }), clients: 0 };
    pipelines.set(id, p);
    p.session.catch(() => forget(id, p));
    lingerUntilUnused(id, p);
    return p;
  }

  function lingerUntilUnused(id: string, p: Pipeline) {
    clearTimeout(p.linger);
    p.linger = setTimeout(() => forget(id, p), LINGER_MS);
    p.linger.unref();
  }

  function forget(id: string, p: Pipeline) {
    if (pipelines.get(id) !== p) return;
    clearTimeout(p.linger);
    pipelines.delete(id);
    void p.session.then((s) => s.stop(), () => {});
  }

  async function sse(req: Request, srv: Bun.Server<undefined>, harnessId: string, key: string): Promise<Response> {
    const found = await resolveRef(harnessId, key);
    if (!found) return new Response("not found", { status: 404 });
    const id = `${found.harness.id}/${found.ref.key}`;
    const p = pipelineFor(id, found.harness, found.ref);
    let session: Session;
    try {
      session = await p.session;
    } catch (err) {
      return new Response(`ipg: ${(err as Error).message}`, { status: 500 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });

    srv.timeout(req, 0); // SSE connections stay open; the default idle timeout would cut them.
    clearTimeout(p.linger);
    p.clients += 1;
    clients += 1;
    clearTimeout(idle);

    let unsubscribe: (() => void) | undefined;
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      unsubscribe?.();
      p.clients -= 1;
      if (p.clients === 0) lingerUntilUnused(id, p);
      clients -= 1;
      if (clients === 0) armIdle();
    };
    req.signal.addEventListener("abort", detach);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (ev: ServerEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        // snapshot() and subscribe() run in one synchronous step, so no event falls between them.
        send(session.snapshot());
        unsubscribe = session.subscribe(send);
      },
      cancel: detach,
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (!hostAllowed(req.headers.get("host"), srv.port ?? 0)) return new Response("forbidden", { status: 403 });
      const url = new URL(req.url);
      const { pathname } = url;
      if (pathname === "/health") {
        const nonce = url.searchParams.get("n");
        return Response.json(nonce ? { app: APP, proof: healthProof(token, nonce) } : { app: APP });
      }
      if (pathname === "/ticket") {
        if (req.method !== "POST" || !same(req.headers.get(KEY_HEADER) ?? "", token)) return new Response("forbidden", { status: 403 });
        const now = Date.now();
        for (const [t, expires] of tickets) if (expires <= now) tickets.delete(t);
        const ticket = randomBytes(24).toString("hex");
        tickets.set(ticket, now + TICKET_MS);
        return Response.json({ ticket });
      }
      if (pathname === "/stop") {
        if (req.method !== "POST" || !same(req.headers.get(STOP_HEADER) ?? "", token)) return new Response("forbidden", { status: 403 });
        // Reply first; close on the next tick so `ipg stop` gets its answer.
        setTimeout(() => {
          daemon.stop();
          opts.onIdle();
        });
        return new Response("stopping");
      }
      const cookie = cookieName(srv.port ?? 0);
      const events = /^\/api\/s\/([^/]+)\/([^/]+)\/events$/.exec(pathname);
      const page = /^\/s\/([^/]+)\/([^/]+)$/.exec(pathname);
      const ticket = url.searchParams.get("k");
      if (page && ticket !== null) {
        const expires = tickets.get(ticket);
        tickets.delete(ticket);
        if (expires === undefined || expires <= Date.now()) return new Response(NO_KEY, { status: 403 });
        // Lax, not Strict: the link may be clicked in another site (a chat page) and must still open.
        return new Response(null, {
          status: 302,
          headers: { location: pathname, "set-cookie": `${cookie}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000` },
        });
      }
      if ((events || page) && !same(cookieOf(req, cookie), token)) return new Response(NO_KEY, { status: 403 });
      if (events) return sse(req, srv, events[1] ?? "", events[2] ?? "");
      if (page) return pageFor(page[1] ?? "", page[2] ?? "");
      const asset = /^\/_web\/([^/]+)$/.exec(pathname);
      if (asset) return assetFor(asset[1] ?? "");
      return new Response("not found", { status: 404 });
    },
  });

  const daemon: Daemon = {
    port: server.port ?? opts.port,
    stop() {
      clearTimeout(idle);
      server.stop(true);
      for (const [id, p] of pipelines) forget(id, p);
    },
  };
  return daemon;
}

async function resolveRef(harnessId: string, key: string): Promise<{ harness: Harness; ref: SessionRef } | undefined> {
  const harness = harnessById(harnessId);
  if (!harness) return undefined;
  try {
    return { harness, ref: await harness.resolve(key) };
  } catch {
    return undefined;
  }
}

async function pageFor(harnessId: string, key: string): Promise<Response> {
  if (!(await resolveRef(harnessId, key))) return new Response("not found", { status: 404 });
  const html = (await webBundle()).get("index.html");
  if (!html) throw new Error("ipg: web bundle has no index.html");
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function assetFor(name: string): Promise<Response> {
  const file = (await webBundle()).get(name);
  return file ? new Response(file) : new Response("not found", { status: 404 });
}

let bundle: Promise<Map<string, Blob>> | undefined;

/** Bundles the page once per process: HTML, TS and CSS become files served under /_web/. */
function webBundle(): Promise<Map<string, Blob>> {
  bundle ??= buildPage();
  return bundle;
}

async function buildPage(): Promise<Map<string, Blob>> {
  const out = await Bun.build({ entrypoints: [PAGE], publicPath: "/_web/" });
  if (!out.success) throw new AggregateError(out.logs, "ipg: web build failed");
  return new Map(out.outputs.map((o) => [o.path.replace(/^\.\//, ""), o] as const));
}

function hostAllowed(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
