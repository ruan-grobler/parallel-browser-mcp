import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
export const VERSION = (require('../package.json') as { version: string }).version;

export const BROWSERS = ['chrome', 'msedge', 'chromium'] as const;
export type BrowserChoice = (typeof BROWSERS)[number];

export type AppConfig = {
  dataDir: string;
  headless: boolean;
  browser: BrowserChoice;
  maxSessions: number;
  concurrency: number;
  idleMinutes: number;
  capabilities?: string[];
};

export const USAGE = `parallel-browser-mcp [options]
  --headed              New sessions show a browser window (default: headless)
  --browser <name>      chrome | msedge | chromium (default: chrome)
  --max-sessions <n>    Max open sessions (default: 8)
  --concurrency <n>     Default run_parallel concurrency (default: 4)
  --idle-minutes <n>    Auto-close idle headless sessions, 0 = never (default: 30)
  --caps <list>         Extra Playwright MCP capabilities, e.g. vision,pdf
  --data-dir <path>     Profiles and output files (default: ~/.parallel-browser)`;

const toInt = (value: string | undefined, fallback: number, flag: string): number => {
  if (value === undefined)
    return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`--${flag} must be a whole number, got "${value}"`);
  return parsed;
};

export const loadConfig = (argv: string[] = process.argv.slice(2)): AppConfig => {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'headed': { type: 'boolean', default: false },
      'browser': { type: 'string', default: 'chrome' },
      'max-sessions': { type: 'string' },
      'concurrency': { type: 'string' },
      'idle-minutes': { type: 'string' },
      'caps': { type: 'string' },
      'data-dir': { type: 'string' },
    },
  });

  const browser = values.browser as BrowserChoice;
  if (!BROWSERS.includes(browser))
    throw new Error(`--browser must be one of ${BROWSERS.join(', ')}, got "${values.browser}"`);

  const maxSessions = Math.max(1, toInt(values['max-sessions'], 8, 'max-sessions'));
  const capabilities = values.caps?.split(',').map((cap) => cap.trim()).filter(Boolean);

  return {
    dataDir: path.resolve(values['data-dir'] ?? path.join(os.homedir(), '.parallel-browser')),
    headless: !values.headed,
    browser,
    maxSessions,
    concurrency: Math.min(maxSessions, Math.max(1, toInt(values.concurrency, 4, 'concurrency'))),
    idleMinutes: toInt(values['idle-minutes'], 30, 'idle-minutes'),
    capabilities: capabilities?.length ? capabilities : undefined,
  };
};
