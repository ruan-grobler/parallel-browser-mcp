// Before and after demo on synthetic pages. Nothing leaves 127.0.0.1.
// Starts a local mock catalogue where every page takes a fixed time to answer, connects to the
// built server over stdio (the way Claude Code does), then runs the SAME task list through
// run_parallel twice: one tab at a time (concurrency 1), then 4 isolated sessions at once.
// Prints a summary report and saves it to docs/demo-output.txt.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PAGES = 8;
const PAGE_DELAY_MS = 1500;
const BEFORE_CONCURRENCY = 1;
const AFTER_CONCURRENCY = 4;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(root, 'docs', 'demo-output.txt');

// Synthetic catalogue data. Every value is made up for the demo.
const item = (id) => ({ sku: `DEMO-${String(id).padStart(3, '0')}`, stock: (id * 7) % 23 });

const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (body) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  };
  if (url.pathname === '/') {
    send('<title>ready</title><p>ready</p>');
    return;
  }
  const id = Number(url.searchParams.get('id'));
  if (url.pathname !== '/item' || !Number.isInteger(id) || id < 1 || id > PAGES) {
    res.writeHead(404);
    res.end();
    return;
  }
  const { sku, stock } = item(id);
  setTimeout(() => send(`<title>Synthetic item ${id}</title><h1>Synthetic item ${id}</h1><p id="sku">${sku}</p><p id="stock">${stock}</p>`), PAGE_DELAY_MS);
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${site.address().port}`;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pb-demo-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js', '--data-dir', dataDir],
  cwd: root,
  stderr: 'pipe',
});
let serverLog = '';
transport.stderr?.on('data', (chunk) => {
  serverLog += chunk;
});
const client = new Client({ name: 'demo', version: '0' });
await client.connect(transport);

const textOf = (result) => result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
const call = async (name, args) => {
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return { result, text: textOf(result), ms: performance.now() - started };
};

// The same task list for both runs: open the page, then read the SKU and stock from it.
const tasks = Array.from({ length: PAGES }, (_, index) => ({
  steps: [
    { tool: 'browser_navigate', args: { url: `${base}/item?id=${index + 1}` } },
    { tool: 'browser_evaluate', args: { function: '() => document.querySelector("#sku").textContent + "|" + document.querySelector("#stock").textContent' } },
  ],
}));

// Splits run_parallel output into one entry per task and checks the data against the catalogue.
const parseRun = (text) => {
  const [summary, ...sections] = text.split(/\n(?==== Task \d+ )/);
  const pages = sections.map((section) => {
    const header = section.match(/^=== Task (\d+) \[session [^\]]+\] (OK|FAILED \([^)]*\)) (\d+\.\d)s/);
    const data = section.match(/"(DEMO-\d{3})\|(\d+)"/);
    const id = Number(header?.[1]);
    const expected = item(id);
    const correct = Boolean(data) && data[1] === expected.sku && Number(data[2]) === expected.stock;
    return { id, ok: header?.[2] === 'OK', status: header?.[2] ?? 'unparsed', seconds: header?.[3] ?? '?', sku: data?.[1] ?? '-', stock: data?.[2] ?? '-', correct };
  });
  return { summary: summary.trim(), pages };
};

const run = async (concurrency) => {
  const { text, ms } = await call('run_parallel', { tasks, concurrency });
  const parsed = parseRun(text);
  const ok = parsed.pages.filter((page) => page.ok).length;
  const correct = parsed.pages.filter((page) => page.correct).length;
  return { ...parsed, raw: text, ms, ok, failed: PAGES - ok, correct };
};

const lines = [];
const out = (line = '') => {
  lines.push(line);
  console.log(line);
};
const secs = (ms) => `${(ms / 1000).toFixed(2)} s`;

// Warm up: launch Chrome and load one page, so neither run pays for the browser starting.
const warm = await call('browser_navigate', { session: 'warm', url: `${base}/` });
const agent = await call('browser_evaluate', { session: 'warm', function: '() => navigator.userAgent' });
const chrome = agent.text.match(/(?:Headless)?Chrome\/(\d+)/)?.[1] ?? 'unknown';

// Other work on the machine slows both runs, so the 1 minute load average is part of the report.
const load = os.loadavg()[0].toFixed(1);
const before = await run(BEFORE_CONCURRENCY);
const after = await run(AFTER_CONCURRENCY);
await call('session_close', { all: true });

const cpu = os.cpus()[0]?.model.trim() ?? 'unknown CPU';
out(`parallel-browser-mcp demo: the same ${PAGES} pages, one tab at a time, then ${AFTER_CONCURRENCY} at a time`);
out(`Run ${new Date().toISOString().slice(0, 10)} on ${os.platform()} ${os.arch()}, ${cpu}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, Node ${process.version}, Chrome ${chrome}, load average ${load} at start`);
out(`Synthetic data: ${PAGES} catalogue pages on a local mock site (127.0.0.1). Each page takes ${PAGE_DELAY_MS} ms to answer.`);
out('Each task opens its page, then reads the SKU and stock with browser_evaluate, in its own throwaway session.');
out();
out(`Chrome start and first page, not counted in either run: ${secs(warm.ms)}${warm.result.isError ? ' (FAILED)' : ''}`);
out();
for (const [label, concurrency, result] of [['BEFORE', BEFORE_CONCURRENCY, before], ['AFTER', AFTER_CONCURRENCY, after]]) {
  out(`${label}: concurrency ${concurrency}`);
  out(`  server says: ${result.summary}`);
  out(`  wall clock ${secs(result.ms)}, pages ok ${result.ok}, failed ${result.failed}, data correct ${result.correct} of ${PAGES}`);
  out();
}
out('Seconds per page (each task, from the server report)');
out(`  ${'page'.padEnd(6)}${'SKU'.padEnd(11)}${'stock'.padEnd(7)}${'before'.padEnd(8)}after`);
for (const page of before.pages) {
  const later = after.pages.find((other) => other.id === page.id);
  out(`  ${String(page.id).padEnd(6)}${page.sku.padEnd(11)}${page.stock.padEnd(7)}${`${page.seconds}s`.padEnd(8)}${later?.seconds ?? '?'}s`);
}
out();
const speedUp = before.ms / after.ms;
const saved = before.ms - after.ms;
out('RESULT');
out(`  ${PAGES} pages: ${secs(before.ms)} before, ${secs(after.ms)} after`);
out(`  speed-up ${speedUp.toFixed(2)}x, ${secs(saved)} saved (${Math.round((saved / before.ms) * 100)}% less waiting)`);
out(`  Lower bound from the page delay alone: ${secs(PAGES * PAGE_DELAY_MS)} one at a time, ${secs(Math.ceil(PAGES / AFTER_CONCURRENCY) * PAGE_DELAY_MS)} with ${AFTER_CONCURRENCY} at a time.`);

const passed = [before, after].every((result) => result.pages.length === PAGES && result.failed === 0 && result.correct === PAGES);
out(passed ? '  All pages loaded and every value matched the synthetic catalogue.' : '  DEMO FAILED: see the raw output below.');
if (!passed) {
  out();
  out(`Raw before output:\n${before.raw}\n\nRaw after output:\n${after.raw}\n\nServer log:\n${serverLog}`);
}

await client.close();
site.close();
await rm(dataDir, { recursive: true, force: true });
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${lines.join('\n')}\n`);
console.log(`\nSaved to ${path.relative(root, reportPath)}`);
process.exit(passed ? 0 : 1);
