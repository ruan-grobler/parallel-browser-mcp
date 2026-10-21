// Unit tests for SessionManager and Session with a mock BrowserPool. No browser is launched.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, mock, test } from 'node:test';
import { SessionManager } from '../../dist/sessions.js';

const URL_A = 'http://127.0.0.1/a';
const SAVED_LOGIN = {
  cookies: [{ name: 'demo_auth', value: 'synthetic', domain: 'example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result) => result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');

// Stands in for a Playwright BrowserContext: just the members the session code touches.
const fakeContext = () => {
  const listeners = {};
  return {
    closed: false,
    storageState: async () => SAVED_LOGIN,
    once: (event, listener) => {
      listeners[event] = listener;
    },
    emit: (event) => listeners[event]?.(),
    pages: () => [],
    async close() {
      this.closed = true;
    },
  };
};

// Stands in for BrowserPool and records what the manager asked it to do.
// The first `failures` context requests fail, like a browser that cannot start.
const fakePool = ({ failures = 0 } = {}) => {
  const calls = { newContext: [], closeShared: [], closeAll: 0 };
  return {
    calls,
    contexts: [],
    async newContext(spec) {
      calls.newContext.push(spec);
      if (calls.newContext.length <= failures)
        throw new Error('Chrome failed to start');
      const context = fakeContext();
      this.contexts.push(context);
      return context;
    },
    closeShared: async (headless) => {
      calls.closeShared.push(headless);
    },
    closeAll: async () => {
      calls.closeAll++;
    },
  };
};

// Session.connect() is private in TypeScript. Swapping it for a fake MCP client
// lets the per-session queue be timed without Playwright or a browser.
const fakeClient = (session, log = [], { delay = 20, fail = new Set() } = {}) => {
  const options = [];
  session.connect = async () => ({
    callTool: async ({ name }, _resultSchema, callOptions) => {
      options.push(callOptions);
      log.push(`start ${name}`);
      await sleep(delay);
      log.push(`end ${name}`);
      if (fail.has(name))
        throw new Error(`${name} failed`);
      return { content: [{ type: 'text', text: name }] };
    },
  });
  return { log, options };
};

let dataDir;
before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'pb-unit-'));
});
after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const setup = (overrides = {}, poolOptions = {}) => {
  const pool = fakePool(poolOptions);
  const config = { dataDir, headless: true, browser: 'chrome', maxSessions: 8, concurrency: 4, idleMinutes: 0, ...overrides };
  return { pool, manager: new SessionManager(config, pool) };
};

describe('session ids', () => {
  test('accepts letters, digits, dot, dash and underscore up to 64 characters', async () => {
    const { manager } = setup();
    for (const id of ['a', 'worker-1', 'crm.main_2', 'x'.repeat(64)])
      assert.equal((await manager.create(id)).id, id);
  });

  test('rejects anything else with a clear message', async () => {
    const { manager } = setup();
    for (const id of ['', 'bad id', 'a/b', '../up', 'semi;colon', 'x'.repeat(65)]) {
      await assert.rejects(manager.create(id), {
        message: `Invalid session id "${id}". Use 1 to 64 letters, digits, dot, dash or underscore.`,
      });
    }
    assert.equal(manager.size, 0);
  });

  test('rejects a duplicate id', async () => {
    const { manager } = setup();
    await manager.create('crm');
    await assert.rejects(manager.create('crm'), /Session "crm" already exists/);
  });
});

describe('session cap', () => {
  test('refuses one more session than --max-sessions and lists what is open', async () => {
    const { manager } = setup({ maxSessions: 2 });
    assert.equal(manager.maxSessions, 2);
    await manager.create('a');
    await manager.create('b');
    await assert.rejects(manager.create('c'), {
      message: 'Session limit reached (2 open). Close finished sessions with session_close, or restart the server with a higher --max-sessions. Open sessions: a, b.',
    });
  });

  test('frees the slot when a session closes', async () => {
    const { manager } = setup({ maxSessions: 1 });
    await manager.create('a');
    assert.equal(await manager.close('a'), true);
    assert.equal((await manager.create('b')).id, 'b');
  });
});

describe('profiles and cloneFrom', () => {
  test('validates profile names', async () => {
    const { manager } = setup();
    await assert.rejects(manager.create('a', { profile: 'bad/name' }), /Invalid profile "bad\/name"/);
  });

  test('locks a profile to one session at a time', async () => {
    const { manager } = setup();
    await manager.create('p1', { profile: 'crm' });
    await assert.rejects(manager.create('p2', { profile: 'crm' }), {
      message: 'Profile "crm" is already open in session "p1". Use that session, or create workers with cloneFrom: "p1".',
    });
  });

  test('refuses profile and cloneFrom together', async () => {
    const { manager } = setup();
    await manager.create('auth');
    await assert.rejects(manager.create('w1', { profile: 'crm', cloneFrom: 'auth' }), /Use profile or cloneFrom, not both/);
  });

  test('refuses to clone a session that is not open', async () => {
    const { manager } = setup();
    await assert.rejects(manager.create('w1', { cloneFrom: 'ghost' }), {
      message: 'cloneFrom: no open session "ghost". No sessions are open.',
    });
  });

  test('copies cookies and storage from the source session', async () => {
    const { manager, pool } = setup();
    await manager.create('auth');
    const worker = await manager.create('w1', { cloneFrom: 'auth' });
    assert.deepEqual(worker.spec.storageState, SAVED_LOGIN);
    assert.equal(worker.spec.clonedFrom, 'auth');
    assert.equal(pool.calls.newContext.length, 1, 'only the source context opens, to read its storage');
    assert.equal(worker.describe(), '- w1: ephemeral, headless, cloned from auth, browser not started yet, idle 0s');
  });
});

describe('session lifecycle', () => {
  test('creating a session does not start a browser', async () => {
    const { manager, pool } = setup();
    const session = await manager.create('lazy', { device: 'iPhone 15' });
    assert.equal(pool.calls.newContext.length, 0);
    assert.equal(session.describe(), '- lazy: ephemeral, headless, iPhone 15, browser not started yet, idle 0s');
  });

  test('headed overrides the server default, otherwise the default applies', async () => {
    const { manager } = setup({ headless: true });
    assert.equal((await manager.create('watch', { headed: true })).spec.headless, false);
    assert.equal((await manager.create('quiet')).spec.headless, true);
    const headedServer = setup({ headless: false }).manager;
    assert.equal((await headedServer.create('visible')).spec.headless, false);
  });

  test('start opens the context once and describe shows its tabs', async () => {
    const { manager, pool } = setup();
    const session = await manager.create('a', { profile: 'crm' });
    await session.start();
    await session.start();
    assert.equal(pool.calls.newContext.length, 1);
    assert.equal(session.describe(), '- a: profile:crm, headless, 0 tabs, idle 0s');
    pool.contexts[0].pages = () => [{ url: () => URL_A }];
    assert.equal(session.describe(), `- a: profile:crm, headless, 1 tab [${URL_A}], idle 0s`);
  });

  test('describe shows how long a session has been idle', async () => {
    const { manager } = setup();
    const session = await manager.create('a');
    session.lastUsed = Date.now() - 42_000;
    assert.match(session.describe(), /idle 42s$/);
    session.lastUsed = Date.now() - 3 * 60_000;
    assert.match(session.describe(), /idle 3m$/);
    session.lastUsed = Date.now() - 125 * 60_000;
    assert.match(session.describe(), /idle 2h5m$/);
  });

  test('getOrCreate reuses an open session', async () => {
    const { manager } = setup();
    const first = await manager.getOrCreate('a');
    assert.equal(await manager.getOrCreate('a'), first);
    assert.equal(manager.size, 1);
  });

  test('the shared browser closes only when its last session closes', async () => {
    const { manager, pool } = setup();
    const a = await manager.create('a');
    const b = await manager.create('b');
    await a.start();
    await b.start();
    await manager.close('a');
    assert.deepEqual(pool.calls.closeShared, []);
    assert.equal(pool.contexts[0].closed, true);
    await manager.close('b');
    assert.deepEqual(pool.calls.closeShared, [true]);
  });

  test('closing a profile session leaves the shared browser alone', async () => {
    const { manager, pool } = setup();
    await manager.create('shared');
    const profile = await manager.create('p', { profile: 'crm' });
    await profile.start();
    await manager.close('p');
    assert.deepEqual(pool.calls.closeShared, []);
    assert.equal(pool.contexts[0].closed, true);
  });

  test('close only closes the exact session it was given', async () => {
    const { manager } = setup();
    const old = await manager.create('a');
    await manager.close('a');
    await manager.create('a');
    assert.equal(await manager.close('a', old), false, 'a newer session reused the id');
    assert.equal(manager.size, 1);
    assert.equal(await manager.close('missing'), false);
  });

  test('closeAll closes every session and the pool', async () => {
    const { manager, pool } = setup();
    await manager.create('a');
    await manager.create('b');
    assert.equal(await manager.closeAll(), 2);
    assert.equal(manager.size, 0);
    assert.equal(pool.calls.closeAll, 1);
    assert.equal(manager.openList(), 'No sessions are open.');
  });

  test('a closed session refuses new calls', async () => {
    const { manager } = setup();
    const session = await manager.create('a');
    await manager.close('a');
    await assert.rejects(session.call('browser_snapshot', {}), { message: 'Session "a" is closed.' });
    await assert.rejects(session.start(), { message: 'Session "a" is closed.' });
  });
});

describe('recovery', () => {
  test('a window closed from outside is replaced on the next use', async () => {
    const { manager, pool } = setup();
    const session = await manager.create('w', { headed: true });
    await session.start();
    pool.contexts[0].emit('close');
    assert.match(session.describe(), /browser not started yet/);
    await session.start();
    assert.equal(pool.calls.newContext.length, 2);
    pool.contexts[0].emit('close');
    assert.match(session.describe(), /0 tabs/, 'a stale close event from the old window is ignored');
  });

  test('a context that fails to open is retried on the next use', async () => {
    const { manager, pool } = setup({}, { failures: 1 });
    const session = await manager.create('a');
    await assert.rejects(session.start(), /Chrome failed to start/);
    await session.start();
    assert.equal(pool.calls.newContext.length, 2);
  });

  test('through the real Playwright MCP code, a browser that cannot start is a tool error and is retried', async () => {
    const { manager, pool } = setup({}, { failures: Infinity });
    const session = await manager.create('x');
    for (const attempt of [1, 2]) {
      const result = await session.call('browser_snapshot', {});
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Chrome failed to start/);
      assert.equal(pool.calls.newContext.length, attempt);
    }
    await manager.close('x');
  });
});

describe('call queue', () => {
  test('calls on one session run one at a time, in order', async () => {
    const { manager } = setup();
    const session = await manager.create('q');
    const { log } = fakeClient(session);
    const calls = ['one', 'two', 'three'].map((name) => session.call(name, {}));
    assert.equal(session.pending, 3);
    assert.match(session.describe(), /busy \(3 calls queued\)$/);
    await Promise.all(calls);
    assert.deepEqual(log, ['start one', 'end one', 'start two', 'end two', 'start three', 'end three']);
    assert.equal(session.pending, 0);
  });

  test('different sessions do not wait for each other', async () => {
    const { manager } = setup();
    const log = [];
    fakeClient(await manager.create('a'), log);
    fakeClient(await manager.create('b'), log);
    await Promise.all([manager.get('a').call('one', {}), manager.get('b').call('two', {})]);
    assert.deepEqual(log.slice(0, 2), ['start one', 'start two']);
  });

  test('a failed call does not block the next one', async () => {
    const { manager } = setup();
    const session = await manager.create('q');
    fakeClient(session, [], { fail: new Set(['bad']) });
    const bad = session.call('bad', {});
    const good = session.call('good', {});
    await assert.rejects(bad, { message: 'bad failed' });
    assert.equal(textOf(await good), 'good');
  });

  test('a call still queued when its session closes is refused', async () => {
    const { manager } = setup();
    const session = await manager.create('q');
    fakeClient(session);
    const running = session.call('one', {});
    const queued = session.call('two', {});
    await sleep(5);
    await manager.close('q');
    assert.equal(textOf(await running), 'one');
    await assert.rejects(queued, { message: 'Session "q" was closed before this call ran.' });
  });

  test('every call carries a 5 minute timeout and the caller\'s abort signal', async () => {
    const { manager } = setup();
    const session = await manager.create('q');
    const { options } = fakeClient(session, [], { delay: 0 });
    const controller = new AbortController();
    await session.call('one', {}, controller.signal);
    assert.deepEqual(options, [{ timeout: 300_000, resetTimeoutOnProgress: true, signal: controller.signal }]);
  });
});

describe('idle timeout', () => {
  test('closes idle headless sessions and leaves headed windows open', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
    const { manager, pool } = setup({ idleMinutes: 30 });
    await manager.create('quiet');
    await manager.create('window', { headed: true });
    t.mock.timers.tick(29 * 60_000);
    await new Promise(setImmediate);
    assert.equal(manager.size, 2, 'nothing closes before the timeout');
    t.mock.timers.tick(2 * 60_000);
    await new Promise(setImmediate);
    assert.deepEqual(manager.list().map((session) => session.id), ['window']);
    assert.deepEqual(pool.calls.closeShared, [true]);
  });

  test('--idle-minutes 0 never starts the timer', (t) => {
    const setIntervalSpy = mock.method(globalThis, 'setInterval');
    t.after(() => setIntervalSpy.mock.restore());
    setup({ idleMinutes: 0 });
    assert.equal(setIntervalSpy.mock.callCount(), 0);
  });
});

describe('Playwright MCP tools', () => {
  test('lists Playwright MCP\'s own tool definitions without launching a browser', async () => {
    const { manager, pool } = setup();
    const tools = await manager.playwrightTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_evaluate', 'browser_close'])
      assert.ok(names.includes(name), `missing ${name}`);
    assert.ok(names.every((name) => name.startsWith('browser_')));
    assert.equal(pool.calls.newContext.length, 0);
  });
});
