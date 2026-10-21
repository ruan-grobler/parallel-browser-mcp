import path from 'node:path';
import pwmcp from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserContext } from 'playwright-core';
import type { BrowserPool, ContextSpec, ResourceKind, StorageState } from './browsers.js';
import { VERSION } from './config.js';
import type { AppConfig } from './config.js';

type PlaywrightMcpConfig = NonNullable<Parameters<typeof pwmcp.createConnection>[0]>;

export type SessionOptions = {
  headed?: boolean;
  profile?: string;
  cloneFrom?: string;
  device?: string;
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  blockResources?: ResourceKind[];
};

const CALL_TIMEOUT_MS = 5 * 60_000;
const SESSION_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const PROFILE_NAME = /^[A-Za-z0-9_-]{1,40}$/;

const noop = (): void => undefined;

const formatAge = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60)
    return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
};

// Runs Playwright MCP's own tool code in-process against a browser context we control.
const connectPlaywright = async (config: PlaywrightMcpConfig, getContext: () => Promise<BrowserContext>): Promise<Client> => {
  const server = await pwmcp.createConnection(config, getContext);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'parallel-browser', version: VERSION });
  await client.connect(clientSide);
  return client;
};

export class Session {
  readonly createdAt = Date.now();
  lastUsed = Date.now();
  pending = 0;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private clientPromise?: Promise<Client>;
  private contextPromise?: Promise<BrowserContext>;
  private context?: BrowserContext;

  constructor(
    readonly id: string,
    readonly spec: ContextSpec,
    private readonly pool: BrowserPool,
    private readonly playwrightConfig: PlaywrightMcpConfig,
  ) {}

  describe(): string {
    const traits = [this.spec.profile ? `profile:${this.spec.profile}` : 'ephemeral', this.spec.headless ? 'headless' : 'headed'];
    if (this.spec.clonedFrom)
      traits.push(`cloned from ${this.spec.clonedFrom}`);
    if (this.spec.device)
      traits.push(this.spec.device);
    const urls = this.context?.pages().map((page) => page.url()) ?? [];
    const tabs = this.context
      ? `${urls.length} tab${urls.length === 1 ? '' : 's'}${urls.length ? ` [${urls.join(', ')}]` : ''}`
      : 'browser not started yet';
    const state = this.pending ? `busy (${this.pending} call${this.pending === 1 ? '' : 's'} queued)` : `idle ${formatAge(Date.now() - this.lastUsed)}`;
    return `- ${this.id}: ${traits.join(', ')}, ${tabs}, ${state}`;
  }

  // Opens the browser context now instead of on the first tool call.
  async start(): Promise<void> {
    await this.getContext();
  }

  async storageState(): Promise<StorageState> {
    return (await this.getContext()).storageState();
  }

  call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    return this.enqueue(async () => {
      const client = await this.connect();
      const options = { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, signal };
      return await client.callTool({ name: tool, arguments: args }, undefined, options) as CallToolResult;
    });
  }

  async close(): Promise<void> {
    if (this.closed)
      return;
    this.closed = true;
    const client = await this.clientPromise?.catch(() => undefined);
    await client?.close().catch(noop);
    const context = await this.contextPromise?.catch(() => undefined);
    await context?.close().catch(noop);
  }

  // Playwright MCP asks for the context lazily, and again after a disconnect,
  // so hand back a fresh one if the old one was closed (for example the user closed the window).
  private readonly getContext = (): Promise<BrowserContext> => {
    if (this.closed)
      return Promise.reject(new Error(`Session "${this.id}" is closed.`));
    if (!this.contextPromise) {
      const creating = this.pool.newContext(this.spec).then((context) => {
        this.context = context;
        context.once('close', () => {
          if (this.contextPromise !== creating)
            return;
          this.contextPromise = undefined;
          this.context = undefined;
        });
        return context;
      });
      creating.catch(() => {
        if (this.contextPromise === creating)
          this.contextPromise = undefined;
      });
      this.contextPromise = creating;
    }
    return this.contextPromise;
  };

  private connect(): Promise<Client> {
    if (!this.clientPromise) {
      const connecting = connectPlaywright(this.playwrightConfig, this.getContext);
      connecting.catch(() => {
        if (this.clientPromise === connecting)
          this.clientPromise = undefined;
      });
      this.clientPromise = connecting;
    }
    return this.clientPromise;
  }

  // One call at a time per session, so two agents can never interleave actions on the same tab.
  // Different sessions never wait on each other.
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error(`Session "${this.id}" is closed.`));
    this.pending++;
    this.lastUsed = Date.now();
    const run = this.tail.then(() => {
      if (this.closed)
        throw new Error(`Session "${this.id}" was closed before this call ran.`);
      return task();
    });
    this.tail = run.then(noop, noop);
    return run.finally(() => {
      this.pending--;
      this.lastUsed = Date.now();
    });
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly config: AppConfig, private readonly pool: BrowserPool) {
    if (config.idleMinutes > 0)
      setInterval(() => void this.closeIdle(), 60_000).unref();
  }

  get maxSessions(): number {
    return this.config.maxSessions;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  openList(): string {
    return this.sessions.size ? `Open sessions: ${[...this.sessions.keys()].join(', ')}.` : 'No sessions are open.';
  }

  async getOrCreate(id: string): Promise<Session> {
    return this.sessions.get(id) ?? this.create(id);
  }

  async create(id: string, options: SessionOptions = {}): Promise<Session> {
    this.checkCanCreate(id, options);
    let storageState: StorageState | undefined;
    if (options.cloneFrom) {
      const source = this.sessions.get(options.cloneFrom);
      if (!source)
        throw new Error(`cloneFrom: no open session "${options.cloneFrom}". ${this.openList()}`);
      storageState = await source.storageState();
      this.checkCanCreate(id, options);
    }
    const { headed, cloneFrom, ...rest } = options;
    const spec: ContextSpec = {
      ...rest,
      headless: headed === undefined ? this.config.headless : !headed,
      clonedFrom: cloneFrom,
      storageState,
    };
    const session = new Session(id, spec, this.pool, this.playwrightConfig(id));
    this.sessions.set(id, session);
    return session;
  }

  // Pass `expected` to close only that exact session, not a newer one that reused the id.
  async close(id: string, expected?: Session): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || (expected && session !== expected))
      return false;
    this.sessions.delete(id);
    await session.close();
    const sharedStillUsed = this.list().some((other) => !other.spec.profile && other.spec.headless === session.spec.headless);
    if (!session.spec.profile && !sharedStillUsed)
      await this.pool.closeShared(session.spec.headless);
    return true;
  }

  async closeAll(): Promise<number> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
    await this.pool.closeAll();
    return ids.length;
  }

  // Tool definitions straight from Playwright MCP, so they always match the installed version.
  async playwrightTools(): Promise<Tool[]> {
    const client = await connectPlaywright(this.playwrightConfig('_tools'), () => Promise.reject(new Error('Tool listing only.')));
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
    }
  }

  private checkCanCreate(id: string, options: SessionOptions): void {
    if (!SESSION_ID.test(id))
      throw new Error(`Invalid session id "${id}". Use 1 to 64 letters, digits, dot, dash or underscore.`);
    if (this.sessions.has(id))
      throw new Error(`Session "${id}" already exists. Use it directly, or session_close it first.`);
    if (this.sessions.size >= this.config.maxSessions)
      throw new Error(`Session limit reached (${this.config.maxSessions} open). Close finished sessions with session_close, or restart the server with a higher --max-sessions. ${this.openList()}`);
    if (options.profile === undefined)
      return;
    if (!PROFILE_NAME.test(options.profile))
      throw new Error(`Invalid profile "${options.profile}". Use 1 to 40 letters, digits, dash or underscore.`);
    if (options.cloneFrom)
      throw new Error('Use profile or cloneFrom, not both. A profile keeps its own logins on disk.');
    const holder = this.list().find((session) => session.spec.profile === options.profile);
    if (holder)
      throw new Error(`Profile "${options.profile}" is already open in session "${holder.id}". Use that session, or create workers with cloneFrom: "${holder.id}".`);
  }

  private async closeIdle(): Promise<void> {
    // Headed sessions are left alone: a visible window is the user's to close.
    const cutoff = Date.now() - this.config.idleMinutes * 60_000;
    const idle = this.list().filter((session) => session.spec.headless && session.pending === 0 && session.lastUsed < cutoff);
    await Promise.all(idle.map((session) => this.close(session.id).catch(noop)));
  }

  private playwrightConfig(id: string): PlaywrightMcpConfig {
    const config: PlaywrightMcpConfig = {
      browser: { isolated: false },
      outputDir: path.join(this.config.dataDir, 'output', id),
      filePaths: 'absolute',
      webmcp: false,
    };
    if (this.config.capabilities)
      config.capabilities = this.config.capabilities as PlaywrightMcpConfig['capabilities'];
    return config;
  }
}
