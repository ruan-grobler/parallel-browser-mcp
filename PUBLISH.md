# Publishing checklist

Everything here is local. Nothing has been pushed or published. Delete this file before you push if you do not want it in the public repo.

## GitHub description

MCP server that runs Playwright MCP's browser tools in many isolated sessions at once, so AI agents can work through web pages in parallel.

## Topics

`mcp`, `model-context-protocol`, `playwright`, `playwright-mcp`, `browser-automation`, `ai-agents`, `claude-code`, `web-scraping`, `typescript`, `headless-chrome`

## What you need to do

Nothing paid. No accounts, API keys or secrets are needed.

1. **Read** `README.md` and `docs/demo-output.txt`. The README table quotes that file. If you run `npm run demo` again, it rewrites the file, so update the table to match.
2. **Optional, commit email.** The commit uses your configured git email. To keep it private, switch to your GitHub noreply address (GitHub, Settings, Emails) and amend before the first push:
   ```bash
   git config user.email "<id>+ruan-grobler@users.noreply.github.com"
   git commit --amend --reset-author --no-edit
   ```
3. **Create the repo yourself** on GitHub as `ruan-grobler/parallel-browser-mcp`, then push:
   ```bash
   gh repo create ruan-grobler/parallel-browser-mcp --public --source . --remote origin
   git push -u origin main
   ```
4. **Add the description and topics** above in the repo's About panel.
5. **Check Actions.** Open the Actions tab and enable workflows if GitHub asks. The CI run needs no secrets. `ubuntu-latest` already has Google Chrome.
6. **Turn on the CI badge.** When the first run is green, uncomment the CI badge at the top of `README.md`, then commit and push.
7. **Local runs need Google Chrome installed.** The server uses the installed Chrome and downloads no browser.

## Scan results

Both scans ran after the initial commit, over the full git history and the working tree. gitleaks is not installed, so the secret scan is a regex scanner for common key patterns.

**Secret scan:**

```text
git repo: True, commits: 1, history blobs scanned: 23, working tree files scanned: 23
findings: 0, placeholder-looking matches: 0
```

**Personal data and employer scan:**

- 0 hits for employer, client and other company names, real people, phone numbers, ID numbers, street addresses, private figures, CV text, PDF files and local paths.
- Expected: the commit metadata holds your configured git email (as author and committer) and the Anthropic noreply address from the Co-Authored-By line. Step 2 swaps in your GitHub noreply address if you want your email private.
- False positive: the domain word check flags the JSON Schema key on `src/server.ts` line 100, where every Playwright tool gets its session argument. It shows once in the tree and once in history. It is code, not content.

## Dependencies

`npm ci` from a clean folder reports `found 0 vulnerabilities`. The MCP SDK is pinned to 1.32.1, which fixes the advisories reported against 1.31.0.
