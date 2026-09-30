#!/usr/bin/env bun
/**
 * dekit-router: port-less local preview URLs for dekit stacks.
 *
 *   dekit-router serve                     run the router (dekit's host runner does this)
 *   dekit-router setup                     add the router to dekit's host runner and start it
 *   dekit-router register <product> <stack> --services main,id,dashboard [--near 3000] [--relay /path=service]…
 *   dekit-router release <product> <stack>
 *   dekit-router ls
 *
 * `register` prints JSON: each service's assigned port, host and URL.
 */
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_HOST, startServer, type Description } from './server.ts';

const VERSION = '0.1.0';
const HELP = `dekit-router ${VERSION}: port-less local preview URLs for dekit stacks

  dekit-router setup                    add the router to dekit's host runner and start it
  dekit-router serve                    run the router (the host runner does this)
  dekit-router register <product> <stack> --services main,id,dashboard [--near 3000] [--relay /path=service]...
  dekit-router release <product> <stack>
  dekit-router ls

Stacks get http://<stack>.<product>.localhost and http://<service>.<stack>.<product>.localhost.
DEKIT_ROUTER_PORT (default 80), DEKIT_ROUTER_STATE (default ~/.local/state/dekit-router/state.json).`;
const PORT = Number(process.env.DEKIT_ROUTER_PORT ?? 80);
const STATE = process.env.DEKIT_ROUTER_STATE ?? join(homedir(), '.local', 'state', 'dekit-router', 'state.json');
const HOST_DIR = join(homedir(), '.config', 'dekit', 'host');

function fail(message: string): never {
  console.error(`dekit-router: ${message}`);
  process.exit(1);
}

/** The control API, addressed on 127.0.0.1 with the control Host header (no DNS needed). */
function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((done, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers: { host: CONTROL_HOST, 'content-type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { done({ status: res.statusCode ?? 0, data: JSON.parse(text) }); } catch { done({ status: res.statusCode ?? 0, data: text }); } });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function running(): Promise<boolean> {
  try { return (await call('GET', '/stacks')).status === 200; } catch { return false; }
}

/** Make sure the router answers: start dekit's host runner if it doesn't. */
async function ensure() {
  if (await running()) return;
  if (!existsSync(join(HOST_DIR, 'dekit.yaml'))) await setup(false);
  spawnSync('dekit', ['up', 'host'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await running()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(`the router isn't answering on :${PORT}; see \`dekit attach host::dekit-router\``);
}

async function setup(start = true) {
  mkdirSync(HOST_DIR, { recursive: true });
  const self = process.execPath.endsWith('/bun') ? `${process.execPath} ${process.argv[1]}` : process.execPath;
  const fragment = join(HOST_DIR, 'dekit-router.yaml');
  writeFileSync(fragment, [
    '# Written by `dekit-router setup`. The machine-wide local preview router.',
    'tasks:',
    '  dekit-router:',
    `    cmd: [${self.split(' ').map((p) => JSON.stringify(p)).join(', ')}, "serve"]`,
    `    ready: { tcp: "127.0.0.1:${PORT}", timeout: 10s }`,
    '    autorestart: on-failure',
    '    autostart: true',
    '',
  ].join('\n'));
  const main = join(HOST_DIR, 'dekit.yaml');
  const text = existsSync(main) ? readFileSync(main, 'utf8') : '';
  if (!/dekit-router\.yaml/.test(text)) {
    writeFileSync(main, text.includes('load:')
      ? text.replace(/load:\s*\[/, 'load: ["dekit-router.yaml", ')
      : `load: ["dekit-router.yaml"]\n${text}`);
  }
  console.log(`dekit-router: host runner config at ${fragment}`);
  if (start) {
    spawnSync('dekit', ['up', 'host'], { stdio: 'inherit' });
    for (let i = 0; i < 50 && !(await running()); i++) await new Promise((r) => setTimeout(r, 200));
    console.log((await running()) ? `dekit-router: answering on :${PORT}` : 'dekit-router: not answering yet; `dekit attach host::dekit-router`');
  }
}

function flags(args: string[]) {
  const out: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) (out[args[i].slice(2)] ??= []).push(args[++i] ?? '');
    else rest.push(args[i]);
  }
  return { out, rest };
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'serve':
    startServer({ port: PORT, state: STATE });
    break;
  case 'setup':
    await setup();
    break;
  case 'register': {
    const { out, rest } = flags(args);
    const [product, stack] = rest;
    if (!product || !stack || !out.services) fail('usage: register <product> <stack> --services main,id,… [--near 3000] [--relay /path=service]');
    const services = out.services[0].split(',').map((s) => (s === 'main' ? '' : s));
    const relay = Object.fromEntries((out.relay ?? []).map((r) => {
      const [path, service] = r.split('=');
      return [path, service === 'main' ? '' : service];
    }));
    await ensure();
    const { status, data } = await call('POST', '/stacks', { product, stack, services, relay, near: Number(out.near?.[0] ?? 3000) });
    if (status >= 400) fail(JSON.stringify(data));
    console.log(JSON.stringify(data as Description, null, 2));
    break;
  }
  case 'release': {
    const [product, stack] = args;
    if (!product || !stack) fail('usage: release <product> <stack>');
    if (!(await running())) break;
    await call('DELETE', `/stacks/${product}/${stack}`);
    break;
  }
  case 'ls': {
    if (!(await running())) fail(`not running on :${PORT}`);
    const { data } = await call('GET', '/stacks');
    for (const d of data as Description[]) {
      for (const [name, s] of Object.entries(d.services)) console.log(`${d.product}/${d.stack}\t${name}\t:${s.port}\t${s.url}`);
    }
    break;
  }
  case '--version':
  case 'version':
    console.log(`dekit-router ${VERSION}`);
    break;
  default:
    console.log(HELP);
    if (command && command !== 'help') process.exit(1);
}
