import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Session, SessionManager, SessionOptions } from './sessions.js';

export type ParallelTask = {
  session?: string;
  steps: Array<{ tool: string; args?: Record<string, unknown> }>;
  create?: SessionOptions;
  closeAfter?: boolean;
};

export type ParallelInput = {
  tasks: ParallelTask[];
  concurrency?: number;
  output?: 'last' | 'all';
  maxChars?: number;
  stopOnError?: boolean;
  taskTimeoutSeconds?: number;
};

type Content = CallToolResult['content'];
type RunOptions = { output: 'last' | 'all'; maxChars: number; stopOnError: boolean; timeoutMs: number; signal?: AbortSignal };
type TaskReport = { header: string; ok: boolean; ms: number; content: Content };

// Keeps a whole batch under Claude Code's default MCP output cap (about 25k tokens).
const TOTAL_CHAR_BUDGET = 80_000;
let batchCount = 0;

class TimeoutError extends Error {}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`Task timed out after ${secs(ms)}.`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const mapLimit = async <T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
};

const truncate = (content: Content, maxChars: number): Content => {
  let budget = maxChars;
  let dropped = 0;
  const kept: Content = [];
  for (const part of content) {
    if (part.type !== 'text') {
      kept.push(part);
      continue;
    }
    if (part.text.length <= budget) {
      kept.push(part);
      budget -= part.text.length;
      continue;
    }
    if (budget > 0)
      kept.push({ type: 'text', text: part.text.slice(0, budget) });
    dropped += part.text.length - Math.max(budget, 0);
    budget = 0;
  }
  if (dropped)
    kept.push({ type: 'text', text: `[truncated ${dropped} chars. Raise maxChars, or return less with browser_evaluate]` });
  return kept;
};

const runTask = async (task: ParallelTask, index: number, batch: number, manager: SessionManager, options: RunOptions): Promise<TaskReport> => {
  const started = Date.now();
  const throwaway = !task.session;
  const id = task.session ?? `tmp${batch}-${index + 1}`;
  const closeAfter = task.closeAfter ?? throwaway;
  const collected: Content = [];
  const notes: string[] = [];
  let failure: string | undefined;
  let session: Session | undefined;

  const runSteps = async (session: Session): Promise<void> => {
    for (const [i, step] of task.steps.entries()) {
      // The task decides the session, so a stray session arg inside a step is ignored.
      const { session: _ignored, ...args } = step.args ?? {};
      const result = await session.call(step.tool, args, options.signal);
      const label = `[step ${i + 1} ${step.tool}${result.isError ? ' FAILED' : ''}]`;
      if (result.isError) {
        failure ??= `step ${i + 1} ${step.tool}`;
        collected.push({ type: 'text', text: label }, ...result.content);
        if (options.stopOnError)
          return;
      } else if (options.output === 'all' || i === task.steps.length - 1) {
        collected.push({ type: 'text', text: label }, ...result.content);
      }
    }
  };

  if (options.signal?.aborted) {
    failure = 'cancelled';
  } else {
    try {
      // A throwaway task always makes its own session, so it can never take over (and close) someone else's.
      session = throwaway ? undefined : manager.get(id);
      if (session && task.create)
        notes.push('session already existed, create options ignored');
      session ??= await manager.create(id, task.create);
      await withTimeout(runSteps(session), options.timeoutMs);
    } catch (error) {
      failure = error instanceof TimeoutError ? 'timeout' : failure ?? 'error';
      collected.push({ type: 'text', text: `Error: ${errorMessage(error)}` });
    } finally {
      if (closeAfter && session)
        await manager.close(id, session).catch(() => undefined);
    }
  }

  const ms = Date.now() - started;
  const status = failure ? `FAILED (${failure})` : 'OK';
  const extras = [closeAfter && session ? 'closed' : '', ...notes].filter(Boolean);
  const header = `Task ${index + 1} [session ${id}] ${status} ${secs(ms)}${extras.length ? ` (${extras.join('; ')})` : ''}`;
  return { header, ok: !failure, ms, content: truncate(collected, options.maxChars) };
};

export const runParallel = async (
  input: ParallelInput,
  manager: SessionManager,
  stepTools: ReadonlySet<string>,
  defaultConcurrency: number,
  signal?: AbortSignal,
): Promise<CallToolResult> => {
  input.tasks.forEach((task, index) => {
    for (const step of task.steps) {
      if (!stepTools.has(step.tool))
        throw new Error(`Task ${index + 1}: "${step.tool}" cannot be a step. Use browser_* tools (for closing, set closeAfter instead of browser_close).`);
    }
  });

  // Throwaway and new named sessions each need a free slot while they run.
  const needSlots = input.tasks.some((task) => !task.session || !manager.get(task.session));
  const free = manager.maxSessions - manager.size;
  if (needSlots && free <= 0)
    throw new Error(`No free session slots (${manager.maxSessions} open). Close sessions with session_close first. ${manager.openList()}`);

  const batch = ++batchCount;
  const concurrency = Math.max(1, Math.min(input.concurrency ?? defaultConcurrency, input.tasks.length, needSlots ? free : Infinity));
  const options: RunOptions = {
    output: input.output ?? 'last',
    maxChars: input.maxChars ?? Math.min(6000, Math.floor(TOTAL_CHAR_BUDGET / input.tasks.length)),
    stopOnError: input.stopOnError ?? true,
    timeoutMs: (input.taskTimeoutSeconds ?? 180) * 1000,
    signal,
  };

  const started = Date.now();
  const reports = await mapLimit(input.tasks, concurrency, (task, index) => runTask(task, index, batch, manager, options));
  const wallMs = Date.now() - started;
  const oneByOneMs = reports.reduce((total, report) => total + report.ms, 0);
  const failed = reports.filter((report) => !report.ok).length;

  const content: Content = [{
    type: 'text',
    text: `run_parallel: ${reports.length} tasks, ${reports.length - failed} ok, ${failed} failed. `
      + `Took ${secs(wallMs)} (one by one would be about ${secs(oneByOneMs)}), concurrency ${concurrency}.`,
  }];
  for (const report of reports)
    content.push({ type: 'text', text: `\n=== ${report.header} ===` }, ...report.content);
  return { content, isError: failed === reports.length };
};
