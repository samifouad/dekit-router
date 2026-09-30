/**
 * The router: one per machine, on port 80.
 *
 * Every local stack registers with it and gets back a group of ports and
 * preview URLs with no port in them:
 *
 *   <stack>.<product>.localhost             the stack's main service ("")
 *   <service>.<stack>.<product>.localhost   every other service
 *
 * It assigns the ports (a free group, every port free on IPv4 and IPv6),
 * remembers them in its state file, and proxies by Host header, WebSockets
 * included (dev-server hot reload).
 *
 * OAuth providers such as GitHub allow one callback URL per app, so a
 * product's dev apps point at `github.<product>.localhost`. The stack name
 * travels in `state` as `<stack>~<anything>`, and the router forwards the
 * browser to that stack's registered service for the path.
 *
 * Control API (JSON) on http://router.localhost:
 *   POST   /stacks  {product, stack, services: ["", "id", …], near?, relay?}
 *   DELETE /stacks/<product>/<stack>
 *   GET    /stacks
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, createServer as netServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CONTROL_HOST = 'router.localhost';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface Entry {
  product: string;
  stack: string;
  /** service name ("" = main) → port */
  services: Record<string, number>;
  /** callback path → service name */
  relay: Record<string, string>;
}

export interface Description {
  product: string;
  stack: string;
  services: Record<string, { port: number; url: string; host: string }>;
  relay: string;
}

export const hostFor = (product: string, stack: string, service: string) =>
  `${service ? `${service}.` : ''}${stack}.${product}.localhost`;

export function describe(entry: Entry): Description {
  const services = Object.fromEntries(Object.entries(entry.services).map(([s, port]) => {
    const host = hostFor(entry.product, entry.stack, s);
    return [s || 'main', { port, host, url: `http://${host}` }];
  }));
  return { product: entry.product, stack: entry.stack, services, relay: `http://github.${entry.product}.localhost` };
}

/** Free on every loopback family this machine has. */
export function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const server = netServer();
    server.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT'));
    server.listen({ port, host, exclusive: true }, () => server.close(() => done(true)));
  });
}

export class Registry {
  stacks: Record<string, Entry> = {};
  constructor(private readonly file: string) {
    try { this.stacks = JSON.parse(readFileSync(file, 'utf8')); } catch { this.stacks = {}; }
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.stacks, null, 2)}\n`);
  }
  route(host: string): { port: number; entry: Entry } | null {
    for (const entry of Object.values(this.stacks)) {
      for (const [service, port] of Object.entries(entry.services)) {
        if (hostFor(entry.product, entry.stack, service) === host) return { port, entry };
      }
    }
    return null;
  }
  async allocate(count: number, near: number): Promise<number[]> {
    const taken = new Set(Object.values(this.stacks).flatMap((e) => Object.values(e.services)));
    for (let base = near; base < near + 1000; base += 10) {
      const ports = Array.from({ length: count }, (_, i) => base + i);
      if (ports.some((p) => taken.has(p))) continue;
      let ok = true;
      for (const p of ports) ok = ok && (await portFree(p, '127.0.0.1')) && (await portFree(p, '::1'));
      if (ok) return ports;
    }
    throw new Error(`no free group of ${count} ports near ${near}`);
  }
  async register(input: { product?: string; stack?: string; services?: string[]; near?: number; relay?: Record<string, string> }): Promise<{ created: boolean; entry: Entry }> {
    const { product = '', stack = '', services = [], near = 3000, relay = {} } = input;
    if (!LABEL.test(product) || !LABEL.test(stack)) throw new RangeError('product and stack must be DNS labels ([a-z0-9-], at most 63)');
    if (!Array.isArray(services) || !services.length || services.some((s) => s !== '' && !LABEL.test(s))) {
      throw new RangeError('services must be a non-empty list of DNS labels ("" for the main one)');
    }
    const key = `${product}/${stack}`;
    const existing = this.stacks[key];
    if (existing && services.every((s) => s in existing.services)) {
      existing.relay = relay;
      this.save();
      return { created: false, entry: existing };
    }
    const ports = await this.allocate(services.length, near);
    const entry: Entry = { product, stack, services: Object.fromEntries(services.map((s, i) => [s, ports[i]])), relay };
    this.stacks[key] = entry;
    this.save();
    return { created: true, entry };
  }
  release(product: string, stack: string): Entry | null {
    const key = `${product}/${stack}`;
    const gone = this.stacks[key] ?? null;
    delete this.stacks[key];
    this.save();
    return gone;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

/** IPv6 loopback first (dev servers bound to `<name>.localhost` often get ::1), then IPv4. */
function reachable(port: number): Promise<string | null> {
  return new Promise((done) => {
    const hosts = ['::1', '127.0.0.1'];
    const attempt = (i: number) => {
      if (i >= hosts.length) return done(null);
      const socket = connect({ port, host: hosts[i] }, () => { socket.destroy(); done(hosts[i]); });
      socket.once('error', () => attempt(i + 1));
    };
    attempt(0);
  });
}

export function startServer(opts: { port: number; state: string; log?: (line: string) => void }) {
  const registry = new Registry(opts.state);
  const log = opts.log ?? ((line) => console.log(line));

  async function control(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean);
    if (path[0] !== 'stacks') return json(res, 404, { error: 'unknown route' });
    if (req.method === 'GET') return json(res, 200, Object.values(registry.stacks).map(describe));
    if (req.method === 'POST') {
      try {
        const { created, entry } = await registry.register(await readJson(req) as Parameters<Registry['register']>[0]);
        log(`${created ? 'registered' : 'reused'} ${entry.product}/${entry.stack} ${JSON.stringify(entry.services)}`);
        return json(res, created ? 201 : 200, describe(entry));
      } catch (error) {
        return json(res, error instanceof RangeError ? 400 : 500, { error: String((error as Error).message) });
      }
    }
    if (req.method === 'DELETE' && path.length === 3) {
      const gone = registry.release(path[1], path[2]);
      if (gone) log(`released ${gone.product}/${gone.stack}`);
      return json(res, gone ? 200 : 404, gone ? { released: describe(gone) } : { error: 'no such stack' });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  function relay(req: IncomingMessage, res: ServerResponse, product: string) {
    const url = new URL(req.url ?? '/', 'http://x');
    const stack = (url.searchParams.get('state') ?? '').split('~')[0];
    const entry = registry.stacks[`${product}/${stack}`];
    const service = entry?.relay?.[url.pathname];
    if (!entry || service === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end(`No local ${product} stack for state "${stack}" at ${url.pathname}.\n`);
    }
    res.writeHead(302, { location: `http://${hostFor(product, stack, service)}${url.pathname}${url.search}`, 'cache-control': 'no-store' });
    res.end();
  }

  const server = createServer(async (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    if (host === CONTROL_HOST) return control(req, res);
    const gh = host.match(/^github\.([a-z0-9-]+)\.localhost$/);
    if (gh) return relay(req, res, gh[1]);
    const found = registry.route(host);
    if (!found) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      return res.end(`No local stack answers ${host}. Registered: ${Object.keys(registry.stacks).join(', ') || 'none'}.\n`);
    }
    const target = await reachable(found.port);
    if (!target) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      return res.end(`${host} is registered on port ${found.port}, but nothing is listening there yet.\n`);
    }
    const out = httpRequest({
      host: target, port: found.port, method: req.method, path: req.url,
      headers: { ...req.headers, 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'http' },
    }, (up) => {
      const headers = { ...up.headers };
      // Dev servers build absolute redirects from their own port; keep the browser on the port-less URL.
      if (typeof headers.location === 'string') headers.location = headers.location.replace(`://${host}:${found.port}`, `://${host}`);
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    });
    out.on('error', (error) => { if (!res.headersSent) res.writeHead(502); res.end(String(error.message)); });
    req.pipe(out);
  });

  server.on('upgrade', async (req, socket, head) => {
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    const found = registry.route(host);
    const target = found && (await reachable(found.port));
    if (!found || !target) return socket.destroy();
    const up = connect({ port: found.port, host: target }, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  server.listen({ port: opts.port, host: '::', ipv6Only: false }, () => {
    log(`dekit-router on :${opts.port} (IPv4 + IPv6), state ${opts.state}, ${Object.keys(registry.stacks).length} stacks`);
  });
  return server;
}
