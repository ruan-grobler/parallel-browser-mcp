import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { RESOURCE_KINDS } from './browsers.js';
import { VERSION } from './config.js';
import type { AppConfig } from './config.js';
import { errorMessage, runParallel } from './parallel.js';
import type { SessionManager } from './sessions.js';

const sessionId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'Use 1 to 64 letters, digits, dot, dash or underscore');

const sessionOptions = {
  headed: z.boolean().optional().describe('Show a visible browser window, for watching or logging in by hand. Default is the server setting (headless).'),
  profile: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional().describe('Persistent profile name. Cookies and logins are saved to disk and survive restarts. One session per profile at a time.'),
  cloneFrom: sessionId.optional().describe('Copy cookies and local storage from this open session, so a new worker starts logged in.'),
  device: z.string().optional().describe('Playwright device to emulate, for example "iPhone 15" or "Pixel 7".'),
  viewport: z.object({ width: z.number().int().min(200).max(4000), height: z.number().int().min(200).max(4000) }).optional(),
  userAgent: z.string().optional(),
  locale: z.string().optional().describe('For example "en-ZA".'),
  timezoneId: z.string().optional().describe('For example "Africa/Johannesburg".'),
  blockResources: z.array(z.enum(RESOURCE_KINDS)).optional().describe('Skip loading these resource types to speed up scraping, for example ["image", "media", "font"].'),
};

const SessionCreateInput = z.object({
  session: sessionId.describe('New session id, for example "crm" or "worker-1".'),
  ...sessionOptions,
}).strict();

const SessionListInput = z.object({}).strict();

const SessionCloseInput = z.object({
  session: sessionId.optional().describe('Session to close.'),
  all: z.boolean().optional().describe('Close every session.'),
}).strict();

const RunParallelInput = z.object({
  tasks: z.array(z.object({
    session: sessionId.optional().describe('Session to run in. Omit for a fresh throwaway session that closes when the task ends.'),
    steps: z.array(z.object({
      tool: z.string().describe('A browser_* tool name, for example "browser_navigate".'),
      args: z.record(z.string(), z.unknown()).optional().describe('Arguments for that tool, exactly as when calling it directly.'),
    }).strict()).min(1).max(30).describe('Run in order inside the task.'),
    create: z.object(sessionOptions).strict().optional().describe('Options for the session if this task creates it.'),
    closeAfter: z.boolean().optional().describe('Close the session when the task ends. Default true for throwaway sessions, false for named ones.'),
  }).strict()).min(1).max(50),
  concurrency: z.number().int().min(1).max(32).optional().describe('How many tasks run at once. Default from server settings, capped by free session slots.'),
  output: z.enum(['last', 'all']).optional().describe('"last" (default) returns each task\'s final step plus any errors. "all" returns every step.'),
  maxChars: z.number().int().min(200).max(200_000).optional().describe('Text cap per task. Default 6000, lower for big batches.'),
  stopOnError: z.boolean().optional().describe('Stop a task at its first failing step. Default true.'),
  taskTimeoutSeconds: z.number().int().min(5).max(1800).optional().describe('Time limit per task. Default 180.'),
}).strict();

const inputSchema = (schema: z.ZodObject): Tool['inputSchema'] => z.toJSONSchema(schema) as Tool['inputSchema'];

const OWN_TOOLS: Tool[] = [
  {
    name: 'session_create',
    title: 'Create browser session',
    description: 'Open a new isolated browser session (own cookies, storage and tabs) with options. Optional: any browser_* call with a new session id creates a default session automatically. '
      + 'Use it for a visible window (headed), a saved login (profile), device emulation, faster scraping (blockResources), or a logged-in worker copied from another session (cloneFrom).',
    inputSchema: inputSchema(SessionCreateInput),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'session_list',
    title: 'List browser sessions',
    description: 'List open sessions with their mode, tabs and whether they are busy.',
    inputSchema: inputSchema(SessionListInput),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'session_close',
    title: 'Close browser sessions',
    description: 'Close one session, or all, and free their memory. Profile sessions keep their saved logins on disk.',
    inputSchema: inputSchema(SessionCloseInput),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'run_parallel',
    title: 'Run browser tasks in parallel',
    description: 'Run many browser tasks at the same time in ONE call. Each task is a list of browser_* steps run in order in its own session; tasks run concurrently server-side. '
      + 'Use it to visit or scrape many pages at once, or to repeat a flow across sessions. Steps cannot use snapshot refs they have not seen, so target elements with CSS selectors '
      + '(target accepts a selector) or use browser_evaluate / browser_run_code_unsafe. Keep output small: end tasks with browser_evaluate returning only the data you need.',
    inputSchema: inputSchema(RunParallelInput),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

const SESSION_PROPERTY = {
  type: 'string',
  description: 'Session id (default "default"). Each session is an isolated browser (own cookies, tabs) that runs in parallel with the others. Created on first use.',
};

const withSession = (tool: Tool): Tool => ({
  ...tool,
  description: tool.name === 'browser_close'
    ? 'Close this session: its tabs, cookies and storage. Profile sessions keep their saved login on disk.'
    : tool.description,
  inputSchema: { ...tool.inputSchema, properties: { session: SESSION_PROPERTY, ...tool.inputSchema.properties } },
});

const instructions = (config: AppConfig): string => `Playwright browser tools with isolated sessions that run in parallel.
- Every browser_* tool takes an optional "session" (default "default"). A session is its own browser context: separate cookies, storage and tabs. It is created on first use.
- Parallel agents: give each agent or workstream its own session id so they never share a tab.
- Many pages at once: use run_parallel. One call, tasks run concurrently server-side (default ${config.concurrency} at a time, ${config.maxSessions} sessions max).
- Logged-in work: session_create with a profile (login saved on disk) or headed: true to log in by hand, then cloneFrom that session for parallel workers.
- Close sessions when done with session_close.${config.idleMinutes ? ` Idle headless sessions close after ${config.idleMinutes} minutes.` : ''}`;

const text = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: `### Error\n${message}` }], isError: true });

const parse = <T extends z.ZodType>(schema: T, args: unknown): z.infer<T> => {
  const result = schema.safeParse(args);
  if (!result.success)
    throw new Error(`Invalid arguments:\n${z.prettifyError(result.error)}`);
  return result.data;
};

export const createServer = async (config: AppConfig, manager: SessionManager): Promise<Server> => {
  const playwrightTools = (await manager.playwrightTools()).map(withSession);
  const proxied = new Set(playwrightTools.map((tool) => tool.name));
  const stepTools = new Set([...proxied].filter((name) => name !== 'browser_close'));
  const tools = [...OWN_TOOLS, ...playwrightTools];

  const sessionCreate = async (input: z.infer<typeof SessionCreateInput>): Promise<CallToolResult> => {
    const { session: id, ...options } = input;
    const session = await manager.create(id, options);
    try {
      await session.start();
    } catch (error) {
      await manager.close(id);
      throw error;
    }
    return text(`Session "${id}" is ready.\n${session.describe()}\nUse any browser_* tool with session: "${id}".`);
  };

  const sessionList = (): CallToolResult => {
    const sessions = manager.list();
    const head = `${sessions.length} of ${config.maxSessions} sessions open. New sessions default to ${config.headless ? 'headless' : 'headed'}.`;
    return text([head, ...sessions.map((session) => session.describe())].join('\n'));
  };

  const sessionClose = async (input: z.infer<typeof SessionCloseInput>): Promise<CallToolResult> => {
    if (input.all) {
      const count = await manager.closeAll();
      return text(`Closed ${count} session${count === 1 ? '' : 's'}.`);
    }
    if (!input.session)
      return fail('Pass session, or all: true.');
    return (await manager.close(input.session))
      ? text(`Closed session "${input.session}".`)
      : fail(`No open session "${input.session}". ${manager.openList()}`);
  };

  // Low-level Server on purpose: the proxied tools arrive as JSON Schema from Playwright MCP, not Zod.
  const server = new Server({ name: 'parallel-browser', version: VERSION }, { capabilities: { tools: {} }, instructions: instructions(config) });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    try {
      switch (name) {
        case 'session_create':
          return await sessionCreate(parse(SessionCreateInput, args));
        case 'session_list':
          parse(SessionListInput, args);
          return sessionList();
        case 'session_close':
          return await sessionClose(parse(SessionCloseInput, args));
        case 'run_parallel':
          return await runParallel(parse(RunParallelInput, args), manager, stepTools, config.concurrency, extra.signal);
      }
      if (!proxied.has(name))
        return fail(`Unknown tool "${name}".`);
      const { session: id = 'default', ...rest } = args;
      if (typeof id !== 'string')
        return fail('session must be a string.');
      if (name === 'browser_close') {
        return (await manager.close(id))
          ? text(`Closed session "${id}".`)
          : text(`No open session "${id}". ${manager.openList()}`);
      }
      const session = await manager.getOrCreate(id);
      return await session.call(name, rest, extra.signal);
    } catch (error) {
      return fail(errorMessage(error));
    }
  });

  return server;
};
