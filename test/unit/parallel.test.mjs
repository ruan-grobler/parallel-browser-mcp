// Unit tests for run_parallel with a mock SessionManager. No browser is launched.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { errorMessage, runParallel } from '../../dist/parallel.js';

const STEP_TOOLS = new Set(['browser_navigate', 'browser_evaluate', 'browser_click', 'browser_take_screenshot']);
const URL_A = 'http://127.0.0.1/a';

const text = (value) => ({ content: [{ type: 'text', text: value }] });
const failure = (value) => ({ content: [{ type: 'text', text: value }], isError: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result) => result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');

// Mock tool behaviour: `ms` delays the call, a click on "#missing" fails like a real missing element.
const defaultRespond = async (tool, args) => {
  await sleep(args.ms ?? 0);
  if (tool === 'browser_click' && args.target === '#missing')
    return failure('Error: no element matches #missing');
  return text(`${tool} ok`);
};

// Stand-in for SessionManager with the members runParallel uses. It records every call.
const mockManager = ({ maxSessions = 8, open = [], respond = defaultRespond, refuse = new Set() } = {}) => {
  const sessions = new Map();
  const state = { events: [], calls: [], created: [], inFlight: 0, peak: 0 };
  const makeSession = (id) => ({
    id,
    call: async (tool, args, signal) => {
      state.calls.push({ id, tool, args, signal });
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      try {
        return await respond(tool, args, id);
      } finally {
        state.inFlight--;
      }
    },
  });
  for (const id of open)
    sessions.set(id, makeSession(id));
  return {
    state,
    maxSessions,
    get size() {
      return sessions.size;
    },
    get: (id) => sessions.get(id),
    create: async (id, options) => {
      if (refuse.has(id))
        throw new Error(`Session limit reached (${maxSessions} open).`);
      const session = makeSession(id);
      sessions.set(id, session);
      state.events.push(`create ${id}`);
      state.created.push({ id, options });
      return session;
    },
    close: async (id, expected) => {
      if (!sessions.has(id) || (expected && sessions.get(id) !== expected))
        return false;
      sessions.delete(id);
      state.events.push(`close ${id}`);
      return true;
    },
    openList: () => (sessions.size ? `Open sessions: ${[...sessions.keys()].join(', ')}.` : 'No sessions are open.'),
  };
};

const navigateTask = (extra = {}) => ({ steps: [{ tool: 'browser_navigate', args: { url: URL_A, ...extra } }] });

describe('step validation', () => {
  test('rejects a step that is not a browser tool before anything runs', async () => {
    const manager = mockManager();
    const input = { tasks: [navigateTask(), { steps: [{ tool: 'session_list' }] }] };
    await assert.rejects(runParallel(input, manager, STEP_TOOLS, 4), {
      message: 'Task 2: "session_list" cannot be a step. Use browser_* tools (for closing, set closeAfter instead of browser_close).',
    });
    assert.deepEqual(manager.state.events, []);
  });

  test('browser_close is not a step, closeAfter is the way to close', async () => {
    await assert.rejects(runParallel({ tasks: [{ steps: [{ tool: 'browser_close' }] }] }, mockManager(), STEP_TOOLS, 4),
      /Task 1: "browser_close" cannot be a step/);
  });
});

describe('session slots', () => {
  test('refuses up front when no session slots are free', async () => {
    const manager = mockManager({ maxSessions: 2, open: ['a', 'b'] });
    await assert.rejects(runParallel({ tasks: [navigateTask()] }, manager, STEP_TOOLS, 4), {
      message: 'No free session slots (2 open). Close sessions with session_close first. Open sessions: a, b.',
    });
  });

  test('still runs tasks on open named sessions when every slot is taken', async () => {
    const manager = mockManager({ maxSessions: 1, open: ['crm'] });
    const result = await runParallel({ tasks: [{ session: 'crm', ...navigateTask() }] }, manager, STEP_TOOLS, 4);
    assert.match(textOf(result), /1 tasks, 1 ok, 0 failed/);
  });

  test('reports a session that cannot be created as that task\'s error', async () => {
    const manager = mockManager({ refuse: new Set(['full']) });
    const result = await runParallel({ tasks: [{ session: 'full', ...navigateTask() }, navigateTask()] }, manager, STEP_TOOLS, 4);
    const output = textOf(result);
    assert.match(output, /2 tasks, 1 ok, 1 failed/);
    assert.match(output, /Task 1 \[session full\] FAILED \(error\)/);
    assert.match(output, /Error: Session limit reached \(8 open\)\./);
    assert.equal(result.isError, false);
  });
});

describe('concurrency', () => {
  test('runs at most `concurrency` tasks at once', async () => {
    const manager = mockManager();
    const tasks = Array.from({ length: 6 }, () => navigateTask({ ms: 20 }));
    const result = await runParallel({ tasks, concurrency: 3 }, manager, STEP_TOOLS, 4);
    assert.equal(manager.state.peak, 3);
    assert.match(textOf(result), /^run_parallel: 6 tasks, 6 ok, 0 failed\. Took \d+\.\ds \(one by one would be about \d+\.\ds\), concurrency 3\./);
  });

  test('caps concurrency at the free session slots', async () => {
    const manager = mockManager({ maxSessions: 4, open: ['busy'] });
    const tasks = Array.from({ length: 6 }, () => navigateTask({ ms: 20 }));
    const result = await runParallel({ tasks, concurrency: 10 }, manager, STEP_TOOLS, 4);
    assert.equal(manager.state.peak, 3);
    assert.match(textOf(result), /concurrency 3\./);
  });

  test('caps concurrency at the number of tasks and falls back to the server default', async () => {
    const two = await runParallel({ tasks: [navigateTask(), navigateTask()], concurrency: 8 }, mockManager(), STEP_TOOLS, 4);
    assert.match(textOf(two), /concurrency 2\./);
    const tasks = Array.from({ length: 5 }, () => navigateTask());
    const byDefault = await runParallel({ tasks }, mockManager(), STEP_TOOLS, 2);
    assert.match(textOf(byDefault), /concurrency 2\./);
  });
});

describe('results and failures', () => {
  const twoSteps = [{ steps: [
    { tool: 'browser_navigate', args: { url: URL_A } },
    { tool: 'browser_evaluate', args: { function: '() => document.title' } },
  ] }];

  test('returns the last step by default and every step with output: all', async () => {
    const last = textOf(await runParallel({ tasks: twoSteps }, mockManager(), STEP_TOOLS, 4));
    assert.ok(!last.includes('[step 1 browser_navigate]'));
    assert.ok(last.includes('[step 2 browser_evaluate]\nbrowser_evaluate ok'));
    const all = textOf(await runParallel({ tasks: twoSteps, output: 'all' }, mockManager(), STEP_TOOLS, 4));
    assert.ok(all.includes('[step 1 browser_navigate]\nbrowser_navigate ok'));
    assert.ok(all.includes('[step 2 browser_evaluate]\nbrowser_evaluate ok'));
  });

  test('one failing task does not sink the batch', async () => {
    const tasks = [
      navigateTask(),
      { steps: [{ tool: 'browser_navigate', args: { url: URL_A } }, { tool: 'browser_click', args: { target: '#missing' } }] },
    ];
    const result = await runParallel({ tasks }, mockManager(), STEP_TOOLS, 4);
    const output = textOf(result);
    assert.equal(result.isError, false);
    assert.match(output, /2 tasks, 1 ok, 1 failed/);
    assert.match(output, /=== Task 1 \[session tmp\d+-1\] OK /);
    assert.match(output, /=== Task 2 \[session tmp\d+-2\] FAILED \(step 2 browser_click\) /);
    assert.ok(output.includes('[step 2 browser_click FAILED]\nError: no element matches #missing'));
  });

  test('stops a task at its first failing step unless stopOnError is false', async () => {
    const tasks = [{ steps: [{ tool: 'browser_click', args: { target: '#missing' } }, { tool: 'browser_evaluate', args: {} }] }];
    const stopping = mockManager();
    await runParallel({ tasks }, stopping, STEP_TOOLS, 4);
    assert.deepEqual(stopping.state.calls.map((call) => call.tool), ['browser_click']);

    const continuing = mockManager();
    const result = await runParallel({ tasks, stopOnError: false }, continuing, STEP_TOOLS, 4);
    assert.deepEqual(continuing.state.calls.map((call) => call.tool), ['browser_click', 'browser_evaluate']);
    assert.match(textOf(result), /FAILED \(step 1 browser_click\)/);
  });

  test('flags the whole result as an error only when every task failed', async () => {
    const bad = { steps: [{ tool: 'browser_click', args: { target: '#missing' } }] };
    const result = await runParallel({ tasks: [bad, bad] }, mockManager(), STEP_TOOLS, 4);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /2 tasks, 0 ok, 2 failed/);
  });

  test('errorMessage reads Error objects and anything else', () => {
    assert.equal(errorMessage(new Error('boom')), 'boom');
    assert.equal(errorMessage('plain'), 'plain');
    assert.equal(errorMessage(42), '42');
  });
});

describe('sessions inside a batch', () => {
  test('throwaway tasks get their own session and always close it', async () => {
    const manager = mockManager();
    const result = await runParallel({ tasks: [navigateTask(), navigateTask()] }, manager, STEP_TOOLS, 4);
    const ids = manager.state.created.map((entry) => entry.id);
    assert.equal(ids.length, 2);
    assert.match(ids[0], /^tmp\d+-1$/);
    assert.match(ids[1], /^tmp\d+-2$/);
    assert.equal(manager.size, 0);
    assert.match(textOf(result), /OK \d+\.\ds \(closed\)/);
  });

  test('named sessions stay open unless closeAfter is set', async () => {
    const manager = mockManager();
    await runParallel({ tasks: [{ session: 'crm', ...navigateTask() }, { session: 'w2', closeAfter: true, ...navigateTask() }] }, manager, STEP_TOOLS, 4);
    assert.ok(manager.get('crm'));
    assert.equal(manager.get('w2'), undefined);
  });

  test('reuses an open named session and says its create options were ignored', async () => {
    const manager = mockManager({ open: ['crm'] });
    const result = await runParallel({ tasks: [{ session: 'crm', create: { headed: true }, ...navigateTask() }] }, manager, STEP_TOOLS, 4);
    assert.deepEqual(manager.state.created, []);
    assert.match(textOf(result), /\[session crm\] OK \d+\.\ds \(session already existed, create options ignored\)/);
  });

  test('passes create options to a new named session', async () => {
    const manager = mockManager();
    await runParallel({ tasks: [{ session: 'w1', create: { device: 'iPhone 15' }, ...navigateTask() }] }, manager, STEP_TOOLS, 4);
    assert.deepEqual(manager.state.created, [{ id: 'w1', options: { device: 'iPhone 15' } }]);
  });

  test('ignores a stray session arg inside a step', async () => {
    const manager = mockManager();
    await runParallel({ tasks: [{ steps: [{ tool: 'browser_navigate', args: { session: 'someone-else', url: URL_A } }] }] }, manager, STEP_TOOLS, 4);
    assert.deepEqual(manager.state.calls[0].args, { url: URL_A });
    assert.notEqual(manager.state.calls[0].id, 'someone-else');
  });
});

describe('output budget', () => {
  const evaluateTask = { steps: [{ tool: 'browser_evaluate', args: {} }] };

  test('truncates long text to maxChars and says how much was dropped', async () => {
    const manager = mockManager({ respond: async () => text('x'.repeat(1000)) });
    const output = textOf(await runParallel({ tasks: [evaluateTask], maxChars: 200 }, manager, STEP_TOOLS, 4));
    // The 25 character step label counts too, so 175 of the 1000 characters fit.
    assert.ok(output.includes(`[step 1 browser_evaluate]\n${'x'.repeat(175)}\n`));
    assert.ok(!output.includes('x'.repeat(176)));
    assert.ok(output.includes('[truncated 825 chars. Raise maxChars, or return less with browser_evaluate]'));
  });

  test('keeps images and only counts text against the budget', async () => {
    const image = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };
    const manager = mockManager({ respond: async () => ({ content: [image, { type: 'text', text: 'y'.repeat(500) }] }) });
    const result = await runParallel({ tasks: [{ steps: [{ tool: 'browser_take_screenshot', args: {} }] }], maxChars: 200 }, manager, STEP_TOOLS, 4);
    assert.ok(result.content.some((part) => part.type === 'image' && part.data === image.data));
    const label = '[step 1 browser_take_screenshot]';
    assert.ok(textOf(result).includes(`[truncated ${500 - (200 - label.length)} chars.`));
  });

  test('shrinks the default budget for big batches', async () => {
    const manager = mockManager({ respond: async () => text('z'.repeat(5000)) });
    const tasks = Array.from({ length: 20 }, () => evaluateTask);
    const output = textOf(await runParallel({ tasks }, manager, STEP_TOOLS, 4));
    // 80,000 characters shared by 20 tasks is 4,000 each, label included.
    assert.equal(output.split('[truncated 1025 chars.').length - 1, 20);
  });
});

describe('timeouts and cancellation', () => {
  test('times out a slow task and still closes its session', async () => {
    const manager = mockManager();
    const result = await runParallel({ tasks: [navigateTask({ ms: 300 })], taskTimeoutSeconds: 0.05 }, manager, STEP_TOOLS, 4);
    const output = textOf(result);
    assert.match(output, /FAILED \(timeout\) \d+\.\ds \(closed\)/);
    assert.ok(output.includes('Error: Task timed out after 0.1s.'));
    assert.equal(manager.size, 0);
  });

  test('a request cancelled before it starts opens no sessions', async () => {
    const manager = mockManager();
    const result = await runParallel({ tasks: [navigateTask(), navigateTask()] }, manager, STEP_TOOLS, 4, AbortSignal.abort());
    assert.equal(result.isError, true);
    assert.equal(textOf(result).split('FAILED (cancelled)').length - 1, 2);
    assert.deepEqual(manager.state.events, []);
  });

  test('cancelling mid-batch skips the tasks that have not started', async () => {
    const controller = new AbortController();
    const manager = mockManager({
      respond: async () => {
        controller.abort();
        return text('done');
      },
    });
    const tasks = [navigateTask(), navigateTask(), navigateTask()];
    const result = await runParallel({ tasks, concurrency: 1 }, manager, STEP_TOOLS, 4, controller.signal);
    const output = textOf(result);
    assert.match(output, /3 tasks, 1 ok, 2 failed/);
    assert.equal(output.split('FAILED (cancelled)').length - 1, 2);
    assert.equal(manager.state.calls[0].signal, controller.signal, 'the signal reaches every tool call');
  });
});
