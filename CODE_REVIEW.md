# Code Review: Multi-Step Onboarding Wizard + Debugger Feature Flag Removal

## Summary

Two distinct changes:

1. **Onboarding wizard expansion** (`first-run-setup.tsx`): The single-step model setup was expanded to a 5-step wizard covering Model, Channels, Agent, Tools, and Skills. The implementation is generally well-structured with good separation of concerns per step, proper loading states in most places, and consistent i18n coverage across all 7 locales. However, there are several correctness and robustness issues that should be addressed.

2. **Debugger feature flag removal**: The `CEB_ENABLE_DEBUGGER_TOOL` env variable and `DEBUGGER_TOOL_ENABLED` constant were removed, making the debugger tool always available (gated only by the user's `enabledTools` config, where it defaults to `false`). This is a clean removal with properly updated tests.

---

## Critical Issues

### C1. Step 5 `useEffect` has no error handling -- can hang forever

**File:** `packages/ui/lib/components/first-run-setup.tsx`, lines 679-713

The `load()` async function inside `useEffect` calls `getDefaultAgent()`, potentially `createAgent()`, `seedPredefinedWorkspaceFiles()`, `listSkillFiles()`, and `parseSkillFrontmatter()`. None of this is wrapped in try/catch. If any of these IndexedDB operations fail (storage quota exceeded, DB corruption, permission error), the promise rejects silently, `setLoading(false)` is never called, and the user sees an infinite loading spinner with no way to proceed.

```tsx
useEffect(() => {
  const load = async () => {
    let agent = await getDefaultAgent();
    if (!agent) {
      agent = { /* ... */ };
      await createAgent(agent);          // Can throw
      await seedPredefinedWorkspaceFiles('main');  // Can throw
    }
    const files = await listSkillFiles();  // Can throw
    // ... parseSkillFrontmatter per file
    setSkills(entries);
    setLoading(false);  // Never reached if any await above throws
  };
  load();
}, []);
```

**Fix:** Wrap the `load()` body in try/catch. In the catch block, call `setLoading(false)` and display an error message. Or use a `finally` block for `setLoading(false)`.

### C2. Step 4 (Tools) silently swallows errors -- user gets stuck

**File:** `packages/ui/lib/components/first-run-setup.tsx`, lines 595-606

`handleNext` has `try/finally` but no `catch`. If `toolConfigStorage.set()` throws, the error is silently lost. `onNext()` is inside the `try` block, so the step never advances. The `finally` block clears `saving`, so the button re-enables, but no error message is shown. The user can click "Next" repeatedly with no feedback about the failure.

Additionally, Step 4 does not declare an `error` state variable at all, unlike Steps 1-3.

```tsx
const handleNext = useCallback(async () => {
  setSaving(true);
  try {
    await toolConfigStorage.set({ enabledTools, webSearchConfig: defaultWebSearchConfig });
    onNext();
  } finally {
    setSaving(false);
  }
}, [enabledTools, onNext]);
```

**Fix:** Add `const [error, setError] = useState('')` to Step 4. Add a `catch` block that calls `setError(...)`. Add the error display JSX that the other steps already have.

### C3. Step 5 (Skills) `handleGetStarted` silently swallows errors

**File:** `packages/ui/lib/components/first-run-setup.tsx`, lines 719-729

Same pattern as C2. `Promise.all(skills.map(...))` is in a try/finally with no catch. If any `updateWorkspaceFile` call fails, `onComplete()` is never called. The button re-enables but the user gets no error feedback and cannot complete the wizard.

**Fix:** Add error state and a catch block.

---

## Warnings

### W1. Duplicate agent creation paths between Steps 3 and 5

**File:** `packages/ui/lib/components/first-run-setup.tsx`

Both Step 3 (lines 471-498) and Step 5 (lines 680-694) independently check for and potentially create a default agent. If the user skips Step 3, Step 5 creates an agent with hardcoded defaults (`name: 'Main Agent'`, `emoji: robot`). If the user completes Step 3 with a custom name/emoji then arrives at Step 5, Step 5 finds the existing agent and proceeds normally.

The issue: the agent creation logic is duplicated and the fallback defaults in Step 5 may not match what the user expects. If Step 3's `createAgent` call succeeded but `seedPredefinedWorkspaceFiles` failed (leaving a partial state), Step 5 would see the agent as existing and skip seeding workspace files -- meaning skills may not be available.

**Recommendation:** Consider having Step 3's skip handler create the default agent (with defaults) rather than skipping entirely. This would eliminate the need for Step 5 to handle agent creation.

### W2. Unused i18n key: `firstRun_startChatting`

**Files:** All 7 locale `messages.json` files define `firstRun_startChatting` (e.g., `en/messages.json` line 58) but it is never referenced in `first-run-setup.tsx`. This appears to be a leftover from the previous single-step wizard.

### W3. Documentation still references removed `CEB_ENABLE_DEBUGGER_TOOL`

**Files:**
- `CLAUDE.md` line 142: `CEB_ENABLE_DEBUGGER_TOOL=false   # Enable CDP debugger tool`
- `README.md` line 349: references `CEB_ENABLE_DEBUGGER_TOOL`

Both files should be updated to remove references to the deleted env variable.

### W4. Step 3 error message is not internationalized

**File:** `packages/ui/lib/components/first-run-setup.tsx`, line 496

```tsx
setError(err instanceof Error ? err.message : 'Failed to save agent');
```

The fallback string `'Failed to save agent'` is a hardcoded English string. All other error messages in the component use `t('firstRun_...')` for i18n. This should use a localized key (e.g., `t('firstRun_saveFailed')` which already exists, or a new agent-specific key).

### W5. `t` missing from `useCallback` dependency array in Step 3

**File:** `packages/ui/lib/components/first-run-setup.tsx`, line 499

```tsx
}, [agentName, agentEmoji, onNext]);
```

While the current code doesn't call `t()` inside this callback, if the hardcoded string is fixed per W4, `t` would need to be in the dependency array. Other step handlers consistently include `t`.

### W6. Step 2 allows saving unvalidated credentials

**File:** `packages/ui/lib/components/first-run-setup.tsx`, lines 347-373

A user can type a bot token and click "Next" without clicking "Validate". The code sends `CHANNEL_SAVE_CONFIG` with potentially invalid credentials. The extension may then start polling with a bad token, causing repeated API errors in the background.

**Recommendation:** Either require validation before enabling the "Next" button when a token is present, or make the "Next" button text/behavior clearer (e.g., "Save & Continue" vs "Skip").

### W7. `listSkillFiles()` called without `agentId` -- returns all agents' skills

**File:** `packages/ui/lib/components/first-run-setup.tsx`, line 696

```tsx
const files = await listSkillFiles();
```

The function signature is `listSkillFiles(agentId?: string): Promise<DbWorkspaceFile[]>`. Without an `agentId`, it returns skill files across all agents. During first run this is likely fine (there's only one agent), but for robustness and correctness, pass `'main'`:

```tsx
const files = await listSkillFiles('main');
```

### W8. E2E test skip-button selector is fragile

**File:** `tests/playwright/helpers/setup.ts`, lines 34-40

```typescript
await page.locator('[data-testid="setup-skip-button"]').first().click();
```

Steps 2, 3, and 4 all use `data-testid="setup-skip-button"`. The test relies on `.first()` which works because only one step renders at a time due to the `{step === N && ...}` pattern. However, if the animation (`animate-in fade-in`) causes brief overlap during transitions, multiple elements could match. Consider adding per-step unique test IDs (e.g., `setup-skip-channels`, `setup-skip-agent`, `setup-skip-tools`).

### W9. No wait between E2E skip clicks

**File:** `tests/playwright/helpers/setup.ts`, lines 34-40

The test clicks skip buttons sequentially without waiting for the step transition to complete:

```typescript
await page.locator('[data-testid="setup-skip-button"]').first().click();
await page.locator('[data-testid="setup-skip-button"]').first().click();
await page.locator('[data-testid="setup-skip-button"]').first().click();
```

Playwright's auto-waiting should handle this in most cases, but since the wizard uses `animate-in fade-in`, there could be timing issues where the old step's button is clicked before the new step renders. Consider adding `waitFor` assertions between clicks, e.g.:

```typescript
await page.locator('[data-testid="setup-skip-button"]').first().click();
await expect(page.locator('text=Configure your agent')).toBeVisible();
```

---

## Suggestions

### S1. Persist wizard progress to survive mid-wizard browser close

If the user closes the browser after Step 1 (which persists the model to `customModelsStorage`), the first-run check (`models.length === 0`) will be false on re-open. The wizard will not show again, but Steps 2-5 were never completed. The user enters the chat UI without agent setup, tool configuration, or skills.

Consider either:
- Storing the current wizard step in Chrome storage and resuming on re-open
- Ensuring the app gracefully initializes defaults for anything the wizard would have configured

### S2. Add accessibility attributes to StepIndicator

**File:** `packages/ui/lib/components/first-run-setup.tsx`, lines 108-134

The step indicator is visual-only. For screen reader users:
- Wrap in `<nav aria-label="Setup progress">`
- Add `aria-current="step"` to the active step
- Consider `role="list"` / `role="listitem"` for the step items

### S3. Emoji input `maxLength={2}` is too restrictive

**File:** `packages/ui/lib/components/first-run-setup.tsx`, line 532

Many emoji (flags, skin-tone variants, ZWJ sequences like family emoji) have JavaScript string lengths > 2. `maxLength={2}` will prevent users from entering these. Consider using a higher limit (e.g., 10) or a grapheme-segmenter-based check.

### S4. Consider extracting step components to separate files

At 829 lines, `first-run-setup.tsx` is large. Each step component is self-contained and could live in its own file for improved maintainability and code navigation.

### S5. Add `data-testid` to "Next" buttons in Steps 2-4

Currently only Step 1's button (`setup-start-button`) and Step 5's button (`setup-get-started-button`) have test IDs. Adding IDs to the intermediate "Next" buttons would enable more targeted E2E testing.

### S6. `iconMap` has no fallback for unknown icon names

**File:** `packages/ui/lib/components/first-run-setup.tsx`, lines 87-104

If `toolRegistryMeta` gains a new group with an `iconName` not in the `iconMap`, the icon renders as `undefined` (nothing shown). Consider a fallback:

```tsx
<span className="text-muted-foreground">{iconMap[group.iconName] ?? <SettingsIcon className="size-4" />}</span>
```

---

## Files Reviewed

| File | Notes |
|------|-------|
| `packages/ui/lib/components/first-run-setup.tsx` | 829-line wizard component. Well-structured per-step separation. Missing error handling in Steps 4 and 5 (Critical). Uninternationalized error in Step 3. |
| `packages/i18n/locales/{en,de,fr,es,ja,zh_CN,zh_TW}/messages.json` | All 7 locales have 33 matching `firstRun_*` keys. One unused key (`firstRun_startChatting`). Telegram keys (`telegram_invalidToken`, etc.) pre-exist in all locales. |
| `tests/playwright/helpers/setup.ts` | Updated to click through all 5 wizard steps. Functional but fragile due to shared `data-testid` and no inter-step waits. |
| `packages/env/lib/const.ts` | Clean removal of `DEBUGGER_TOOL_ENABLED` constant. 10 lines, no issues. |
| `packages/env/lib/types.ts` | Clean removal of `CEB_ENABLE_DEBUGGER_TOOL` from `ICebEnv`. 17 lines, no issues. |
| `packages/shared/lib/tool-registry.ts` | Removed debugger feature-flag filter from `filteredToolRegistryMeta`. Debugger group now always included (still defaults to disabled). No issues. |
| `chrome-extension/src/background/tools/index.ts` | Removed feature-flag gate for debugger tool. Now purely config-driven via `isEnabled('debugger')`. Clean change. |
| `chrome-extension/src/background/tools/tool-definitions.test.ts` | Debugger tests updated to verify enable/disable via tool config. Comprehensive, covering both `getAgentTools` and `executeTool`. No issues. |
| `.env` | Removed `CEB_ENABLE_DEBUGGER_TOOL` line. File is clean. |
| `CLAUDE.md` / `README.md` | Still reference `CEB_ENABLE_DEBUGGER_TOOL` -- stale documentation (Warning W3). |
