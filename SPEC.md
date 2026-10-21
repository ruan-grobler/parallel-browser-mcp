# parallel-browser MCP: spec

Playwright MCP, but with many isolated browser sessions running at the same time.

## Goal

- **Same tools as Playwright MCP.** All `browser_*` tools, same snapshots, refs and behaviour.
- **Sessions.** Every tool takes a `session` id. Each session is its own browser context (own cookies, storage, tabs). Created on first use.
- **True parallelism.** Calls on different sessions run at the same time. Calls on one session queue in order, so they never collide.
- **`run_parallel`.** One call runs many sessions' step lists concurrently, server-side. This is the speed tool for scraping or repeating a flow across many pages.
- **Log in once, fan out.** Persistent `profile` sessions keep logins on disk. `cloneFrom` copies a logged-in session into new workers.

## Constraints

- **8 GB RAM Mac.** One shared headless Chrome, sessions are cheap contexts inside it. Caps: 8 open sessions, 4 parallel tasks by default. Idle headless sessions auto-close after 30 min.
- **No new downloads.** Uses the installed Google Chrome, like Playwright MCP.
- **Reuse, don't rewrite.** Each session runs Playwright MCP's own tool code in-process (`createConnection` with our own browser context). Upgrades are a version bump.
- **Local only.** stdio transport, nothing exposed on the network.

## Done when

- `npm run build` is clean.
- Smoke test proves: parallel speed-up, cookie isolation, `cloneFrom`, profile persistence, same-session ordering, session cap, clean shutdown with no orphan Chrome.
- Registered in Claude Code at user scope and `claude mcp list` shows it Connected.
