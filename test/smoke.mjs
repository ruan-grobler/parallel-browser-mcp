// End-to-end smoke test. Spawns the server over stdio (like Claude Code does) against a local
// test site, then checks parallel speed-up, isolation, cloneFrom, profiles, ordering, the session cap and shutdown.
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const html = (body, headers = {}) => {
    res.writeHead(200, { 'content-type': 'text/html', ...headers });
    res.end(body);
  };
  if (url.pathname === '/slow') {
    const id = url.searchParams.get('id') ?? '?';
    setTimeout(() => html(`<title>Page ${id}</title><h1>Hello ${id}</h1>`), Number(url.searchParams.get('ms') ?? 1000));
  } else if (url.pathname === '/login') {
    html('<title>login</title><p>logged in</p>', { 'set-cookie': 'pb_auth=yes; Path=/; Max-Age=3600' });
  } else if (url.pathname === '/whoami') {
    html(`<title>whoami</title><p id="who">${req.headers.cookie ?? 'anonymous'}</p>`);
  } else if (url.pathname === '/form') {
    html('<title>form</title><input id="q"><button id="go" onclick="document.title = \'clicked \' + document.getElementById(\'q\').value">Go</button>');
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${site.address().port}`;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pb-smoke-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js', '--data-dir', dataDir, '--max-sessions', '6'],
  stderr: 'pipe',
});
let serverLog = '';
transport.stderr?.on('data', (chunk) => {
  serverLog += chunk;
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok)
    failures++;
};
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  return { ...result, text };
};
const timed = async (fn) => {
  const started = Date.now();
  const result = await fn();
  return [result, Date.now() - started];
};
const readWho = (session) => call('browser_evaluate', { session, function: '() => document.querySelector("#who").textContent' });

// 1. Tool list
const { tools } = await client.listTools();
const names = tools.map((tool) => tool.name);
check('lists Playwright tools plus session tools',
  ['session_create', 'session_list', 'session_close', 'run_parallel', 'browser_snapshot', 'browser_click'].every((name) => names.includes(name)),
  `${tools.length} tools`);
check('browser_* tools take a session arg', tools.find((tool) => tool.name === 'browser_navigate')?.inputSchema.properties?.session?.type === 'string');

// 2. Warm-up, so the timings below measure sessions and not Chrome starting
const [warm, warmMs] = await timed(() => call('browser_navigate', { session: 'warm', url: `${base}/slow?ms=0&id=warm` }));
check('first call launches Chrome and navigates', !warm.isError && warm.text.includes('Page warm'), `${warmMs}ms`);

// 3. run_parallel speed-up
const DELAY = 2000;
const [batch, batchMs] = await timed(() => call('run_parallel', {
  tasks: [1, 2, 3, 4].map((i) => ({
    steps: [
      { tool: 'browser_navigate', args: { url: `${base}/slow?ms=${DELAY}&id=${i}` } },
      { tool: 'browser_evaluate', args: { function: '() => document.title' } },
    ],
  })),
  concurrency: 4,
}));
check('run_parallel returns every task result', !batch.isError && [1, 2, 3, 4].every((i) => batch.text.includes(`"Page ${i}"`)));
// The server reports the sum of the task times. A wall clock under half that sum means more than
// 2 tasks ran at once on average, however fast or busy the machine is.
const oneByOneMs = Number(batch.text.match(/one by one would be about ([\d.]+)s/)?.[1]) * 1000;
check('run_parallel runs tasks at the same time', batchMs * 2 < oneByOneMs,
  `${batchMs}ms for 4 pages that each take ${DELAY}ms, ${(oneByOneMs / batchMs).toFixed(1)} at once on average`);
console.log(`      ${batch.text.split('\n')[0]}`);
check('throwaway batch sessions close afterwards', !(await call('session_list')).text.includes('- tmp'));

// 4. Direct calls on different sessions overlap
const [, directMs] = await timed(() => Promise.all(['a', 'b'].map((session) => call('browser_navigate', { session, url: `${base}/slow?ms=${DELAY}&id=${session}` }))));
check('direct calls on different sessions run at the same time', directMs < DELAY * 1.8, `${directMs}ms for 2 x ${DELAY}ms`);

// 5. Calls on one session queue in order
const [queued, queuedMs] = await timed(() => Promise.all(['x', 'y'].map((id) => call('browser_navigate', { session: 'a', url: `${base}/slow?ms=1000&id=${id}` }))));
const finalTitle = await call('browser_evaluate', { session: 'a', function: '() => document.title' });
check('same-session calls run one after another',
  queued.every((result) => !result.isError) && queuedMs >= 2000 && finalTitle.text.includes('"Page y"'),
  `${queuedMs}ms`);

// 6. Isolation and cloneFrom
await call('browser_navigate', { session: 'auth', url: `${base}/login` });
await call('browser_navigate', { session: 'b', url: `${base}/whoami` });
check('sessions do not share cookies', (await readWho('b')).text.includes('anonymous'));
const clone = await call('session_create', { session: 'worker', cloneFrom: 'auth' });
await call('browser_navigate', { session: 'worker', url: `${base}/whoami` });
check('cloneFrom copies the login into a new worker', !clone.isError && (await readWho('worker')).text.includes('pb_auth=yes'));

// 7. Session cap (server started with --max-sessions 6)
await call('browser_navigate', { session: 'sixth', url: `${base}/slow?ms=0&id=6` });
const over = await call('browser_navigate', { session: 'seventh', url: `${base}/slow?ms=0&id=7` });
check('session cap gives a clear error', over.isError && over.text.includes('Session limit reached'));
const noSlots = await call('run_parallel', { tasks: [{ steps: [{ tool: 'browser_snapshot' }] }] });
check('run_parallel refuses when no slots are free', noSlots.isError && noSlots.text.includes('No free session slots'));

// 8. session_list, browser_close, session_close
const list = await call('session_list');
check('session_list shows open sessions', list.text.startsWith('6 of 6') && list.text.includes('- auth:'));
await call('browser_close', { session: 'sixth' });
await call('session_close', { session: 'b' });
check('browser_close and session_close free their slots', (await call('session_list')).text.startsWith('4 of 6'));

// 9. Steps can target CSS selectors, named batch sessions stay open
const form = await call('run_parallel', {
  tasks: [{
    session: 'formtest',
    steps: [
      { tool: 'browser_navigate', args: { url: `${base}/form` } },
      { tool: 'browser_type', args: { target: '#q', text: 'hello' } },
      { tool: 'browser_click', args: { target: '#go' } },
      { tool: 'browser_evaluate', args: { function: '() => document.title' } },
    ],
  }],
});
check('run_parallel steps can target CSS selectors', form.text.includes('clicked hello'));
check('named batch sessions stay open', (await call('session_list')).text.includes('- formtest:'));

// 10. One failing task does not sink the batch
const mixed = await call('run_parallel', {
  tasks: [
    { steps: [{ tool: 'browser_navigate', args: { url: `${base}/slow?ms=0&id=ok` } }, { tool: 'browser_evaluate', args: { function: '() => document.title' } }] },
    { steps: [{ tool: 'browser_navigate', args: { url: `${base}/slow?ms=0&id=bad` } }, { tool: 'browser_click', args: { target: '#missing' } }] },
  ],
});
check('failures are reported per task', !mixed.isError && mixed.text.includes('1 ok, 1 failed') && mixed.text.includes('"Page ok"'));

// 11. Bad input
const badStep = await call('run_parallel', { tasks: [{ steps: [{ tool: 'session_list' }] }] });
check('rejects steps that are not browser tools', badStep.isError && badStep.text.includes('cannot be a step'));
const badId = await call('browser_navigate', { session: 'bad id!', url: base });
check('rejects bad session ids', badId.isError && badId.text.includes('Invalid session id'));

// 12. Profiles keep logins across close and reopen
check('session_close all', (await call('session_close', { all: true })).text.startsWith('Closed 5 sessions'));
await call('session_create', { session: 'p1', profile: 'smoke' });
await call('browser_navigate', { session: 'p1', url: `${base}/login` });
const locked = await call('session_create', { session: 'p2', profile: 'smoke' });
check('a profile can only be open in one session', locked.isError && locked.text.includes('already open'));
await call('session_close', { session: 'p1' });
await call('session_create', { session: 'p2', profile: 'smoke' });
await call('browser_navigate', { session: 'p2', url: `${base}/whoami` });
check('profile login survives close and reopen', (await readWho('p2')).text.includes('pb_auth=yes'));

// 13. Shutdown leaves no Chrome behind
const children = () => {
  try {
    return execSync(`pgrep -P ${transport.pid}`).toString().trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const chromePids = children();
check('Chrome runs as a child of the server', chromePids.length > 0, `${chromePids.length} child process(es)`);
await client.close();
await new Promise((resolve) => setTimeout(resolve, 3000));
const alive = chromePids.filter((pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
});
check('closing the client shuts every browser down', alive.length === 0, alive.length ? `still alive: ${alive.join(', ')}` : '');

site.close();
await rm(dataDir, { recursive: true, force: true });
if (failures)
  console.log(`\nServer log:\n${serverLog}`);
console.log(`\n${failures ? `${failures} FAILED` : 'ALL PASSED'}`);
process.exit(failures ? 1 : 0);
