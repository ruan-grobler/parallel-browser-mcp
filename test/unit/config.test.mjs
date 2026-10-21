// Unit tests for CLI flag parsing and defaults. Pure logic, no browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { loadConfig, USAGE, VERSION } from '../../dist/config.js';

describe('loadConfig', () => {
  test('uses safe defaults when no flags are given', () => {
    assert.deepEqual(loadConfig([]), {
      dataDir: path.join(os.homedir(), '.parallel-browser'),
      headless: true,
      browser: 'chrome',
      maxSessions: 8,
      concurrency: 4,
      idleMinutes: 30,
      capabilities: undefined,
    });
  });

  test('parses every flag', () => {
    const config = loadConfig([
      '--headed',
      '--browser', 'msedge',
      '--max-sessions', '3',
      '--concurrency', '2',
      '--idle-minutes', '0',
      '--caps', 'vision, pdf,',
      '--data-dir', 'tmp/data',
    ]);
    assert.deepEqual(config, {
      dataDir: path.resolve('tmp/data'),
      headless: false,
      browser: 'msedge',
      maxSessions: 3,
      concurrency: 2,
      idleMinutes: 0,
      capabilities: ['vision', 'pdf'],
    });
  });

  test('caps concurrency at the session limit', () => {
    const config = loadConfig(['--max-sessions', '2', '--concurrency', '10']);
    assert.equal(config.maxSessions, 2);
    assert.equal(config.concurrency, 2);
  });

  test('keeps sessions and concurrency at 1 or more', () => {
    const config = loadConfig(['--max-sessions', '0', '--concurrency', '0']);
    assert.equal(config.maxSessions, 1);
    assert.equal(config.concurrency, 1);
  });

  test('treats an empty --caps list as no extra capabilities', () => {
    assert.equal(loadConfig(['--caps', ' , ']).capabilities, undefined);
  });

  test('rejects an unknown browser with the allowed list', () => {
    assert.throws(() => loadConfig(['--browser', 'firefox']), {
      message: '--browser must be one of chrome, msedge, chromium, got "firefox"',
    });
  });

  test('rejects numbers that are not whole and positive', () => {
    assert.throws(() => loadConfig(['--max-sessions', '2.5']), { message: '--max-sessions must be a whole number, got "2.5"' });
    assert.throws(() => loadConfig(['--concurrency', 'lots']), { message: '--concurrency must be a whole number, got "lots"' });
    assert.throws(() => loadConfig(['--idle-minutes=-1']), { message: '--idle-minutes must be a whole number, got "-1"' });
  });

  test('rejects unknown flags instead of ignoring them', () => {
    assert.throws(() => loadConfig(['--max-session', '4']), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' });
  });
});

describe('USAGE and VERSION', () => {
  test('USAGE documents every flag', () => {
    for (const flag of ['--headed', '--browser', '--max-sessions', '--concurrency', '--idle-minutes', '--caps', '--data-dir'])
      assert.ok(USAGE.includes(flag), `USAGE is missing ${flag}`);
  });

  test('VERSION comes from package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(VERSION, pkg.version);
  });
});
