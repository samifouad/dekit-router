import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';

// Tests run the router on a high port against a throwaway state file.
const PORT = 18_080;
let router: Server;
const upstreams: Server[] = [];

function call(host: string, method: string, path: string, body?: unknown): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
  return new Promise((done, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers: { host, 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function upstream(port: number, reply: (path: string, host: string) => [number, Record<string, string>, string]): Promise<void> {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const [status, headers, text] = reply(req.url ?? '/', String(req.headers['x-forwarded-host'] ?? ''));
      res.writeHead(status, headers);
      res.end(text);
    });
    upstreams.push(server);
    server.listen(port, '127.0.0.1', () => done());
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'dekit-router-'));
  router = startServer({ port: PORT, state: join(dir, 'state.json'), log: () => {} });
  await new Promise((r) => router.once('listening', r));
});
afterAll(() => {
  router.close();
  for (const s of upstreams) s.close();
});

test('register assigns a free group of ports and port-less URLs', async () => {
  const res = await call('router.localhost', 'POST', '/stacks', { product: 'cqx', stack: 'fix-kimi', services: ['', 'id', 'dashboard'], near: 31_000 });
  expect(res.status).toBe(201);
  const d = JSON.parse(res.text);
  expect(d.services.main).toMatchObject({ port: 31_000, url: 'http://fix-kimi.cqx.localhost' });
  expect(d.services.id).toMatchObject({ port: 31_001, url: 'http://id.fix-kimi.cqx.localhost' });
  expect(d.services.dashboard.port).toBe(31_002);
});

test('a second stack never gets the first one\'s ports; re-registering reuses them', async () => {
  const other = JSON.parse((await call('router.localhost', 'POST', '/stacks', { product: 'cqx', stack: 'other-codex', services: ['', 'id'], near: 31_000 })).text);
  expect(other.services.main.port).toBe(31_010);
  const again = await call('router.localhost', 'POST', '/stacks', { product: 'cqx', stack: 'fix-kimi', services: ['', 'id', 'dashboard'], near: 31_000 });
  expect(again.status).toBe(200);
  expect(JSON.parse(again.text).services.main.port).toBe(31_000);
});

test('a port something else already holds is skipped', async () => {
  await upstream(31_020, () => [200, {}, 'busy']);
  const d = JSON.parse((await call('router.localhost', 'POST', '/stacks', { product: 'zega', stack: 'busy-sami', services: [''], near: 31_020 })).text);
  expect(d.services.main.port).toBe(31_030);
});

test('invalid names are refused', async () => {
  expect((await call('router.localhost', 'POST', '/stacks', { product: 'cqx', stack: 'Bad_Name', services: [''] })).status).toBe(400);
  expect((await call('router.localhost', 'POST', '/stacks', { product: 'cqx', stack: 'ok', services: [] })).status).toBe(400);
});

test('requests are proxied by Host, and redirects lose the internal port', async () => {
  await upstream(31_001, (path, host) => (path === '/go'
    ? [302, { location: `http://id.fix-kimi.cqx.localhost:31001/there` }, '']
    : [200, { 'content-type': 'text/plain' }, `id says ${path} via ${host}`]));
  const ok = await call('id.fix-kimi.cqx.localhost', 'GET', '/hello');
  expect(ok.status).toBe(200);
  expect(ok.text).toBe('id says /hello via id.fix-kimi.cqx.localhost');
  const moved = await call('id.fix-kimi.cqx.localhost', 'GET', '/go');
  expect(moved.headers.location).toBe('http://id.fix-kimi.cqx.localhost/there');
});

test('an unknown host answers 502 and names what is registered', async () => {
  const res = await call('nope.cqx.localhost', 'GET', '/');
  expect(res.status).toBe(502);
  expect(res.text).toContain('cqx/fix-kimi');
});

test('the GitHub relay sends the browser to the stack named in state', async () => {
  await call('router.localhost', 'POST', '/stacks', { product: 'cqx', stack: 'fix-kimi', services: ['', 'id', 'dashboard'], relay: { '/connect/callback': '', '/auth/github/callback': 'id' } });
  const setup = await call('github.cqx.localhost', 'GET', '/connect/callback?installation_id=7&state=fix-kimi~abc');
  expect(setup.status).toBe(302);
  expect(setup.headers.location).toBe('http://fix-kimi.cqx.localhost/connect/callback?installation_id=7&state=fix-kimi~abc');
  const oauth = await call('github.cqx.localhost', 'GET', '/auth/github/callback?code=1&state=fix-kimi~xyz');
  expect(oauth.headers.location).toBe('http://id.fix-kimi.cqx.localhost/auth/github/callback?code=1&state=fix-kimi~xyz');
  expect((await call('github.cqx.localhost', 'GET', '/connect/callback?state=someone-else~1')).status).toBe(404);
});

test('release frees the stack', async () => {
  expect((await call('router.localhost', 'DELETE', '/stacks/cqx/other-codex')).status).toBe(200);
  const list = JSON.parse((await call('router.localhost', 'GET', '/stacks')).text);
  expect(list.map((d: { stack: string }) => d.stack)).not.toContain('other-codex');
});
