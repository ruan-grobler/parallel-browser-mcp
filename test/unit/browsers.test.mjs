// Unit tests for BrowserPool. chromium.launch is replaced with a fake, so no browser starts.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { chromium, devices } from 'playwright-core';
import { BrowserPool, RESOURCE_KINDS } from '../../dist/browsers.js';

const config = { dataDir: path.resolve('pb-data'), headless: true, browser: 'chrome', maxSessions: 8, concurrency: 4, idleMinutes: 0 };

const fakeContext = (options) => ({
  options,
  routes: [],
  async route(pattern, handler) {
    this.routes.push({ pattern, handler });
  },
});

const fakeBrowser = (launchOptions, { failClose = false } = {}) => {
  const listeners = {};
  return {
    launchOptions,
    closed: false,
    on: (event, listener) => {
      listeners[event] = listener;
    },
    disconnect: () => listeners.disconnected?.(),
    newContext: async (options) => fakeContext(options),
    async close() {
      if (failClose)
        throw new Error('already gone');
      this.closed = true;
    },
  };
};

// Replaces chromium.launch for one test and keeps every fake browser it hands out.
const mockLaunch = (t, { failFirst = false, failClose = false } = {}) => {
  const browsers = [];
  let calls = 0;
  const launch = t.mock.method(chromium, 'launch', async (options) => {
    calls++;
    if (failFirst && calls === 1)
      throw new Error('Chrome failed to start');
    const browser = fakeBrowser(options, { failClose });
    browsers.push(browser);
    return browser;
  });
  return { browsers, launch };
};

describe('shared browser', () => {
  test('launches one browser per mode and reuses it for every context', async (t) => {
    const { launch } = mockLaunch(t);
    const pool = new BrowserPool(config);
    await pool.newContext({ headless: true });
    await pool.newContext({ headless: true });
    await pool.newContext({ headless: false });
    assert.deepEqual(launch.mock.calls.map((call) => call.arguments[0]), [
      { headless: true, channel: 'chrome' },
      { headless: false, channel: 'chrome' },
    ]);
  });

  test('uses the bundled Chromium channel only when asked', async (t) => {
    const { launch } = mockLaunch(t);
    await new BrowserPool({ ...config, browser: 'chromium' }).newContext({ headless: true });
    await new BrowserPool({ ...config, browser: 'msedge' }).newContext({ headless: true });
    assert.deepEqual(launch.mock.calls.map((call) => call.arguments[0].channel), [undefined, 'msedge']);
  });

  test('relaunches after the browser disconnects', async (t) => {
    const { browsers, launch } = mockLaunch(t);
    const pool = new BrowserPool(config);
    await pool.newContext({ headless: true });
    browsers[0].disconnect();
    await pool.newContext({ headless: true });
    assert.equal(launch.mock.callCount(), 2);
  });

  test('forgets a failed launch so the next call tries again', async (t) => {
    const { launch } = mockLaunch(t, { failFirst: true });
    const pool = new BrowserPool(config);
    await assert.rejects(pool.newContext({ headless: true }), /Chrome failed to start/);
    await pool.newContext({ headless: true });
    assert.equal(launch.mock.callCount(), 2);
  });

  test('closeShared closes one mode and closeAll closes the rest', async (t) => {
    const { browsers } = mockLaunch(t);
    const pool = new BrowserPool(config);
    await pool.newContext({ headless: true });
    await pool.newContext({ headless: false });
    await pool.closeShared(true);
    assert.deepEqual(browsers.map((browser) => browser.closed), [true, false]);
    await pool.closeAll();
    assert.deepEqual(browsers.map((browser) => browser.closed), [true, true]);
    await pool.closeAll();
  });

  test('a browser that fails to close does not stop shutdown', async (t) => {
    const { browsers } = mockLaunch(t, { failClose: true });
    const pool = new BrowserPool(config);
    await pool.newContext({ headless: true });
    await pool.closeAll();
    assert.equal(browsers[0].closed, false);
  });
});

describe('profiles', () => {
  test('a profile gets its own persistent browser in the profile folder', async (t) => {
    const { launch } = mockLaunch(t);
    const persistent = t.mock.method(chromium, 'launchPersistentContext', async (dir, options) => fakeContext({ dir, ...options }));
    const pool = new BrowserPool(config);
    assert.equal(pool.profileDir('crm'), path.join(config.dataDir, 'profiles', 'crm'));
    await pool.newContext({ headless: false, profile: 'crm', locale: 'en-ZA' });
    assert.deepEqual(persistent.mock.calls[0].arguments, [
      path.join(config.dataDir, 'profiles', 'crm'),
      { headless: false, channel: 'chrome', locale: 'en-ZA' },
    ]);
    assert.equal(launch.mock.callCount(), 0);
  });
});

describe('context options', () => {
  test('applies a device first, then explicit options on top', async (t) => {
    mockLaunch(t);
    const storageState = { cookies: [], origins: [] };
    const context = await new BrowserPool(config).newContext({
      headless: true,
      device: 'iPhone 15',
      viewport: { width: 800, height: 600 },
      userAgent: 'synthetic-agent',
      locale: 'en-ZA',
      timezoneId: 'Africa/Johannesburg',
      storageState,
    });
    assert.deepEqual(context.options, {
      ...devices['iPhone 15'],
      viewport: { width: 800, height: 600 },
      userAgent: 'synthetic-agent',
      locale: 'en-ZA',
      timezoneId: 'Africa/Johannesburg',
      storageState,
    });
  });

  test('fails fast on an unknown device, before any browser starts', async (t) => {
    const { launch } = mockLaunch(t);
    await assert.rejects(new BrowserPool(config).newContext({ headless: true, device: 'Nokia 3310' }), /^Error: Unknown device "Nokia 3310"\. Examples: "/);
    assert.equal(launch.mock.callCount(), 0);
  });

  test('blockResources aborts the listed resource types and lets the rest through', async (t) => {
    mockLaunch(t);
    assert.deepEqual([...RESOURCE_KINDS], ['image', 'media', 'font', 'stylesheet']);
    const context = await new BrowserPool(config).newContext({ headless: true, blockResources: ['image', 'font'] });
    assert.equal(context.routes.length, 1);
    const { pattern, handler } = context.routes[0];
    assert.equal(pattern, '**/*');
    const request = (type) => {
      const route = { outcome: '', request: () => ({ resourceType: () => type }) };
      route.abort = async () => {
        route.outcome = 'aborted';
      };
      route.continue = async () => {
        route.outcome = 'continued';
      };
      return route;
    };
    const outcomes = [];
    for (const type of ['image', 'font', 'document', 'script']) {
      const route = request(type);
      await handler(route);
      outcomes.push(`${type} ${route.outcome}`);
    }
    assert.deepEqual(outcomes, ['image aborted', 'font aborted', 'document continued', 'script continued']);
  });

  test('no blockResources means no request routing', async (t) => {
    mockLaunch(t);
    const context = await new BrowserPool(config).newContext({ headless: true, blockResources: [] });
    assert.equal(context.routes.length, 0);
  });
});
