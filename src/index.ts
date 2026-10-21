#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrowserPool } from './browsers.js';
import { loadConfig, USAGE, VERSION } from './config.js';
import { createServer } from './server.js';
import { SessionManager } from './sessions.js';

// stdout is the MCP channel, so all logging goes to stderr.
const log = (message: string): void => {
  process.stderr.write(`[parallel-browser] ${message}\n`);
};

const main = async (): Promise<void> => {
  if (process.argv.includes('--help')) {
    process.stderr.write(`${USAGE}\n`);
    return;
  }
  const config = loadConfig();
  // Each session's Playwright MCP instance adds process listeners; many sessions would trip the default limit of 10.
  process.setMaxListeners(Math.max(50, config.maxSessions * 4));
  process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${String(reason)}`));

  const manager = new SessionManager(config, new BrowserPool(config));
  const server = await createServer(config, manager);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping)
      return;
    stopping = true;
    const deadline = new Promise((resolve) => setTimeout(resolve, 5000).unref());
    await Promise.race([manager.closeAll().catch(() => undefined), deadline]);
    process.exit(0);
  };
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('close', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await server.connect(new StdioServerTransport());
  log(`v${VERSION} ready: browser=${config.browser}, ${config.headless ? 'headless' : 'headed'}, max ${config.maxSessions} sessions, concurrency ${config.concurrency}`);
};

main().catch((error: unknown) => {
  log(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
