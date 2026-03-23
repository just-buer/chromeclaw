# Plan: Fix Firefox CSP Violation + Tool Loop Detection Gap

## Context

Two related issues when the LLM uses `execute_javascript` on Firefox:

1. **CSP violation** — Firefox's `execute-js-firefox.ts` uses `eval(expr)` inside `chrome.scripting.executeScript({ world: 'MAIN' })`. This works fine on regular pages (e.g. `about:blank`) but fails on the extension's `sandbox.html` because Firefox enforces a strict CSP on extension pages that blocks `eval()` regardless of the manifest's `'unsafe-eval'` directive.

2. **Tool loop detection gap** — When the CSP error hits, the LLM retries `execute_javascript` 15+ times with different arguments (different bundling strategies). Each call has unique args and a different error message, so none of the existing detection strategies trigger. The `isError` flag from `agent-loop.ts` is never passed to `recordToolCallOutcome()`.

## Fix 1: Firefox Sandbox CSP — Use `about:blank` Instead of `sandbox.html`

**File:** `chrome-extension/src/background/tools/execute-js-firefox.ts`

**Root cause:** `sandbox.html` is an extension page (`chrome-extension://...`). Firefox enforces a browser-level CSP on extension pages that blocks `eval()` even when `'unsafe-eval'` is declared in the manifest. Regular web pages like `about:blank` have no such restriction.

**Change:** In `createSandboxTabFirefox()` (line 31-43), use `about:blank` instead of `chrome.runtime.getURL('sandbox.html')`:

```typescript
const createSandboxTabFirefox = async (): Promise<number> => {
  // Use about:blank instead of sandbox.html — Firefox blocks eval() on extension
  // pages due to browser-enforced CSP, but about:blank has no CSP restrictions.
  const url = 'about:blank';
  const tabs = await chrome.tabs.query({ url });
  // about:blank may match many tabs — look for one we previously created
  // by checking for our __cc marker
  if (tabs.length > 0 && tabs[0].id != null) {
    sandboxTabId = tabs[0].id;
    return sandboxTabId;
  }

  const tab = await chrome.tabs.create({ url, active: false });
  sandboxTabId = tab.id!;
  return sandboxTabId;
};
```

**Problem with `about:blank` matching:** `chrome.tabs.query({ url: 'about:blank' })` would match ALL blank tabs in the browser, not just our sandbox. We need a way to identify our specific tab.

**Better approach:** Don't query for orphan tabs at all — just always create a new one. The orphan detection was a nice-to-have for reusing tabs across SW restarts. On Firefox, just track the tab ID in memory and recreate if it's gone:

```typescript
const createSandboxTabFirefox = async (): Promise<number> => {
  // Use about:blank — Firefox blocks eval() on extension pages (sandbox.html)
  // due to browser-enforced CSP restrictions.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  sandboxTabId = tab.id!;
  return sandboxTabId;
};
```

The orphan reuse in `ensureSandboxTabFirefox()` (lines 45-64) already handles the case where `sandboxTabId` is set — it checks `chrome.tabs.get()` and creates a new tab if the old one is gone. So removing the query from `createSandboxTabFirefox` is safe.

## Fix 2: Tool Loop Detection — Same-Tool Consecutive Error Strategy

### Files to modify

1. **`chrome-extension/src/background/agents/tool-loop-detection.ts`**
2. **`chrome-extension/src/background/agents/agent-loop.ts`**
3. **`chrome-extension/src/background/agents/tool-loop-detection.test.ts`**

### Changes in `tool-loop-detection.ts`

1. **Add `isError?: boolean` to `ToolCallRecord`** (after line 80)

2. **Add config fields to `ToolLoopConfig`** (after `largeResultSizeBytes`):
   - `consecutiveErrorWarningThreshold: number` — default 5
   - `consecutiveErrorBreakerThreshold: number` — default 8

3. **Add defaults to `DEFAULT_TOOL_LOOP_CONFIG`**

4. **Update `recordToolCallOutcome`** — add optional `isError?: boolean` parameter, store it on the entry

5. **Add `getConsecutiveSameToolErrorStreak` helper** (after `getGlobalNoProgressStreak`):
   - Scans backwards from tail
   - Counts entries where `toolName` matches AND `isError === true`
   - Breaks on different tool or non-error call
   - Treats `undefined` isError as non-error

6. **Insert strategy #6** in `detectToolCallLoop` between large-result stagnation and high-cost warning:
   - Circuit breaker at `consecutiveErrorBreakerThreshold` (default 8)
   - Warning at `consecutiveErrorWarningThreshold` (default 5)
   - Guard: `if (config.consecutiveErrorBreakerThreshold > 0)`

7. **Renumber** subsequent strategies in comments (6→7, 7→8), update header JSDoc

8. **Export** `getConsecutiveSameToolErrorStreak`

### Changes in `agent-loop.ts`

- Line ~496: `recordToolCallOutcome(toolLoopState, toolCall.id, result, isError)` — thread existing `isError` variable
- Line ~448 (blocked-call path): Pass `true` for isError

### Changes in `tool-loop-detection.test.ts`

- Add new config fields to `smallConfig` (3 warning, 5 breaker — matches scaled-down pattern)
- Update `recordWithResult` helper with optional `isError` param
- Add `describe('getConsecutiveSameToolErrorStreak')` with unit tests
- Add integration tests for warning + circuit breaker + negative cases

## Verification

```bash
# Run the loop detection tests
pnpm test -- --run chrome-extension/tests/tool-loop-detection

# Type check
pnpm type-check

# Build Firefox and test execute_javascript sandbox
pnpm build:firefox
```

Manual test: Load the Firefox extension, open a chat, ask it to run `execute_javascript({ action: 'execute', code: 'return 2 + 2' })` — should return `4` without CSP errors.
