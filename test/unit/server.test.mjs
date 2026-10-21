// Unit tests for the MCP server: tool list, input validation and routing.
// A real MCP client talks to the server in memory. The session manager is a mock, so no browser starts.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../dist/server.js';
import { SessionManager } from '../../dist/sessions.js';

const URL_A = 'http://127.0.0.1/a';
const textOf = (result) => result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');

let dataDir;
let config;
let playwrightTools;
before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'pb-unit-'));
  config = { dataDir, headless: true, browser: 'chrome', maxSessions: 3, concurrency: 2, idleMinutes: 30 };
  // The real tool definitions from Playwright MCP. Listing them never asks the pool for a browser.
  playwrightTools = await new SessionManager({ ...config, idleMinutes: 0 }, {}).playwrightTools();
});
after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// Stand-in for SessionManager with the members the server uses. It records every call.
const mockManager = ({ startFails = false } = {}) => {
  const sessions = new Map();
  const state = { calls: [], created: [], closed: [] };
  const create = async (id, options = {}) => {
    const session = {
      id,
      describe: () => `- ${id}: ephemeral, headless, browser not started yet, idle 0s`,
      start: async () => {
        if (startFails)
          throw new Error('Chrome is not installed');
      },
      call: async (tool, args) => {
        state.calls.push({ id, tool, args });
        return { content: [{ type: 'text', text: `${tool} ran in ${id}` }] };
      },
    };
    sessions.set(id, session);
    state.created.push({ id, options });
    return session;
  };
  return {
    state,
    maxSessions: config.maxSessions,
    get size() {
      return sessions.size;
    },
    playwrightTools: async () => playwrightTools,
    get: (id) => sessions.get(id),
    list: () => [...sessions.values()],
    openList: () => (sessions.size ? `Open sessions: ${[...sessions.keys()].join(', ')}.` : 'No sessions are open.'),
    create,
    getOrCreate: async (id) => {
      if (id === 'over-cap')
        throw new Error('Session limit reached (3 open).');
      return sessions.get(id) ?? create(id);
    },
    close: async (id) => {
      if (!sessions.delete(id))
        return false;
      state.closed.push(id);
      return true;
    },
    closeAll: async () => {
      const count = sessions.size;
      sessions.clear();
      return count;
    },
  };
};

const connect = async (t, manager, serverConfig = config) => {
  const server = await createServer(serverConfig, manager);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'unit', version: '0' });
  await client.connect(clientSide);
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, text: textOf(result) };
  };
  return { client, call };
};

describe('tool list', () => {
  test('has the session tools plus every Playwright MCP tool, each with an optional session arg', async (t) => {
    const { client } = await connect(t, mockManager());
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ['session_create', 'session_list', 'session_close', 'run_parallel'])
      assert.ok(names.includes(name), `missing ${name}`);
    const browserTools = tools.filter((tool) => tool.name.startsWith('browser_'));
    assert.equal(browserTools.length, playwrightTools.length);
    for (const tool of browserTools) {
      assert.equal(tool.inputSchema.properties.session.type, 'string', `${tool.name} has no session arg`);
      assert.ok(!(tool.inputSchema.required ?? []).includes('session'), `${tool.name} requires session`);
    }
    const close = tools.find((tool) => tool.name === 'browser_close');
    assert.equal(close.description, 'Close this session: its tabs, cookies and storage. Profile sessions keep their saved login on disk.');
  });

  test('tells the client its limits', async (t) => {
    const { client } = await connect(t, mockManager());
    assert.match(client.getInstructions(), /default 2 at a time, 3 sessions max/);
    assert.match(client.getInstructions(), /Idle headless sessions close after 30 minutes\./);
    const { client: noIdle } = await connect(t, mockManager(), { ...config, idleMinutes: 0 });
    assert.doesNotMatch(noIdle.getInstructions(), /Idle headless sessions/);
  });
});

describe('browser_* routing', () => {
  test('sends each call to its session, "default" when none is given', async (t) => {
    const manager = mockManager();
    const { call } = await connect(t, manager);
    assert.equal((await call('browser_navigate', { url: URL_A })).text, 'browser_navigate ran in default');
    assert.equal((await call('browser_navigate', { session: 'crm', url: URL_A })).text, 'browser_navigate ran in crm');
    assert.deepEqual(manager.state.calls, [
      { id: 'default', tool: 'browser_navigate', args: { url: URL_A } },
      { id: 'crm', tool: 'browser_navigate', args: { url: URL_A } },
    ]);
  });

  test('rejects a session that is not a string', async (t) => {
    const { call } = await connect(t, mockManager());
    const result = await call('browser_navigate', { session: 5, url: URL_A });
    assert.equal(result.isError, true);
    assert.equal(result.text, '### Error\nsession must be a string.');
  });

  test('answers an unknown tool with a clear error', async (t) => {
    const { call } = await connect(t, mockManager());
    const result = await call('browser_teleport');
    assert.equal(result.isError, true);
    assert.equal(result.text, '### Error\nUnknown tool "browser_teleport".');
  });

  test('turns manager errors into tool errors', async (t) => {
    const { call } = await connect(t, mockManager());
    const result = await call('browser_snapshot', { session: 'over-cap' });
    assert.equal(result.isError, true);
    assert.equal(result.text, '### Error\nSession limit reached (3 open).');
  });

  test('browser_close closes the session it names', async (t) => {
    const manager = mockManager();
    const { call } = await connect(t, manager);
    await call('browser_navigate', { session: 'crm', url: URL_A });
    assert.equal((await call('browser_close', { session: 'crm' })).text, 'Closed session "crm".');
    const again = await call('browser_close', { session: 'crm' });
    assert.equal(again.isError, undefined);
    assert.equal(again.text, 'No open session "crm". No sessions are open.');
  });
});

describe('session tools', () => {
  test('session_create validates ids, profile names and options before creating anything', async (t) => {
    const manager = mockManager();
    const { call } = await connect(t, manager);
    const badId = await call('session_create', { session: 'bad id!' });
    assert.equal(badId.isError, true);
    assert.match(badId.text, /Invalid arguments/);
    assert.match(badId.text, /Use 1 to 64 letters, digits, dot, dash or underscore/);
    for (const args of [
      { session: 'a', profile: 'bad/name' },
      { session: 'a', colour: 'red' },
      { session: 'a', viewport: { width: 50, height: 50 } },
      { session: 'a', blockResources: ['scripts'] },
    ]) {
      const result = await call('session_create', args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.text, /^### Error\nInvalid arguments/);
    }
    assert.deepEqual(manager.state.created, []);
  });

  test('session_create starts the session and says how to use it', async (t) => {
    const manager = mockManager();
    const { call } = await connect(t, manager);
    const result = await call('session_create', { session: 'crm', device: 'iPhone 15' });
    assert.equal(result.text, 'Session "crm" is ready.\n- crm: ephemeral, headless, browser not started yet, idle 0s\nUse any browser_* tool with session: "crm".');
    assert.deepEqual(manager.state.created, [{ id: 'crm', options: { device: 'iPhone 15' } }]);
  });

  test('session_create closes the session again when the browser fails to start', async (t) => {
    const manager = mockManager({ startFails: true });
    const { call } = await connect(t, manager);
    const result = await call('session_create', { session: 'crm' });
    assert.equal(result.isError, true);
    assert.equal(result.text, '### Error\nChrome is not installed');
    assert.deepEqual(manager.state.closed, ['crm']);
    assert.equal(manager.size, 0);
  });

  test('session_list shows the count and every session', async (t) => {
    const manager = mockManager();
    const { call } = await connect(t, manager);
    await manager.create('a');
    await manager.create('b');
    assert.equal((await call('session_list')).text, [
      '2 of 3 sessions open. New sessions default to headless.',
      '- a: ephemeral, headless, browser not started yet, idle 0s',
      '- b: ephemeral, headless, browser not started yet, idle 0s',
    ].join('\n'));
    assert.equal((await call('session_list', { extra: true })).isError, true);
  });

  test('session_close closes one or all, and explains a bad request', async (t) => {
    const manager = mockManager();
    const { call } = await connect(t, manager);
    assert.equal((await call('session_close')).text, '### Error\nPass session, or all: true.');
    assert.equal((await call('session_close', { session: 'ghost' })).text, '### Error\nNo open session "ghost". No sessions are open.');
    await manager.create('a');
    await manager.create('b');
    assert.equal((await call('session_close', { session: 'a' })).text, 'Closed session "a".');
    assert.equal((await call('session_close', { all: true })).text, 'Closed 1 session.');
    assert.equal((await call('session_close', { all: true })).text, 'Closed 0 sessions.');
  });
});

describe('run_parallel', () => {
  const step = { tool: 'browser_navigate', args: { url: URL_A } };

  test('validates the batch before running anything', async (t) => {
    const manager = mockManager();
    const { call } = await connect(t, manager);
    for (const args of [
      { tasks: [] },
      { tasks: [{ steps: [step] }], concurrency: 0 },
      { tasks: [{ steps: Array.from({ length: 31 }, () => step) }] },
      { tasks: [{ steps: [step] }], parallel: true },
      { tasks: [{ session: 'bad id!', steps: [step] }] },
    ]) {
      const result = await call('run_parallel', args);
      assert.equal(result.isError, true, JSON.stringify(args).slice(0, 80));
      assert.match(result.text, /^### Error\nInvalid arguments/);
    }
    const notAStep = await call('run_parallel', { tasks: [{ steps: [{ tool: 'session_list' }] }] });
    assert.match(notAStep.text, /"session_list" cannot be a step/);
    const close = await call('run_parallel', { tasks: [{ steps: [{ tool: 'browser_close' }] }] });
    assert.match(close.text, /"browser_close" cannot be a step/);
    assert.deepEqual(manager.state.calls, []);
  });

  test('runs the steps in the named session', async (t) => {
    const manager = mockManager();
    const { call } = await connect(t, manager);
    const result = await call('run_parallel', { tasks: [{ session: 'crm', steps: [step] }] });
    assert.match(result.text, /^run_parallel: 1 tasks, 1 ok, 0 failed\./);
    assert.deepEqual(manager.state.calls, [{ id: 'crm', tool: 'browser_navigate', args: { url: URL_A } }]);
  });
});
