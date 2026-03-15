# Firefox Compatibility — Implementation Plan

## Context

ChromeClaw's build system already supports Firefox (`IS_FIREFOX`, manifest conversion, `.xpi` packaging). Test files for Firefox behavior already exist but **all fail** because the runtime code hasn't been adapted yet. This plan implements the actual Firefox runtime compatibility per the design in `~/dev/FIREFOX_COMPATIBILITY_DESIGN.md`.

**Approach:** Use existing `webextension-polyfill` for standard APIs (~350 call sites). For Chrome-only APIs, prefer **feature detection** and **dependency injection** over `IS_FIREFOX` branching. Isolate the few unavoidable browser-specific checks into small utility modules so business logic stays browser-agnostic.

**Architectural principle:** Minimize `IS_FIREFOX` in business logic. Use abstractions:
- **Feature detection** (`typeof api?.method === 'function'`) — browser-agnostic, no flag needed
- **Dependency injection** (pass storage interface, swap backend) — decouples from environment
- **Thin utility modules** (keep-alive, side-panel) — one check in one place, callers are clean

---

## File Changes (16 files: 5 new, 11 modified)

### 1. NEW: `chrome-extension/src/background/utils/keep-alive.ts`

Extract keep-alive alarm logic into a single utility. `IS_FIREFOX` appears **once here only** — all 3 consumers (index.ts, subagent.ts, agent-handler.ts) become browser-agnostic.

```typescript
import { IS_FIREFOX } from '@extension/env';

export const createKeepAliveManager = (alarmName: string) => {
  let refCount = 0;
  return {
    acquire: () => {
      refCount++;
      if (!IS_FIREFOX && refCount === 1) {
        chrome.alarms.create(alarmName, { periodInMinutes: 0.4 });
      }
    },
    release: () => {
      refCount = Math.max(0, refCount - 1);
      if (!IS_FIREFOX && refCount === 0) {
        chrome.alarms.clear(alarmName);
      }
    },
    clearOrphan: () => {
      if (!IS_FIREFOX) {
        chrome.alarms.clear(alarmName);
      }
    },
  };
};
```

---

### 2. NEW: `packages/shared/lib/utils/side-panel.ts`

Extract side panel operations behind feature detection. **Zero `IS_FIREFOX`** — pure capability check.

```typescript
/** Open the sidebar — works on Chrome (sidePanel) and Firefox (sidebarAction). */
export const openSidePanel = async (): Promise<void> => {
  if (typeof chrome.sidePanel?.open === 'function') {
    await chrome.sidePanel.open({});
  } else if (
    typeof (globalThis as any).browser?.sidebarAction?.open === 'function'
  ) {
    await (globalThis as any).browser.sidebarAction.open();
  }
};

/** Register side panel open-on-click behavior (Chrome only, no-op elsewhere). */
export const initSidePanelBehavior = (): void => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
    .catch(() => {});
};
```

---

### 3. NEW: `chrome-extension/src/background/tools/browser-firefox.ts`

Create the Firefox browser tool using `chrome.scripting.executeScript` + `chrome.tabs.*` instead of CDP.

```ts
// Full implementation of executeBrowserFirefox()
// Actions:
//   tabs       → chrome.tabs.query({}) → formatted list
//   open       → chrome.tabs.create({ url, active })
//   close      → chrome.tabs.remove(tabId)
//   focus      → chrome.tabs.update + chrome.windows.update
//   navigate   → chrome.tabs.update(tabId, { url }) + wait tabs.onUpdated status=complete
//   content    → chrome.scripting.executeScript → document.body.innerText
//   snapshot   → chrome.scripting.executeScript → inject DOM walker (inline version of walkNode)
//   screenshot → chrome.tabs.captureVisibleTab() (viewport only, no fullPage without CDP)
//   evaluate   → chrome.scripting.executeScript with user expression
//   click      → return error: "use evaluate with querySelector().click() instead"
//   type       → return error: "use evaluate with querySelector + value assignment instead"
//   console    → return "Console monitoring is unavailable on Firefox"
//   network    → return "Network monitoring is unavailable on Firefox"
```

---

### 4. NEW: `pages/offscreen-channels/src/message-router.ts`

Extract the `chrome.runtime.onMessage` handler from `index.ts` into a shared module that accepts a storage interface via dependency injection. **Zero `IS_FIREFOX`** — the caller decides what storage backend to inject.

```typescript
import type { StorageProxy } from './storage-proxy';

/** Register the worker message router with the given storage backend. */
export const registerWorkerRouter = (storage: StorageProxy): void => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Skip self-echoed messages (when router runs in background page on Firefox)
    if ((message as Record<string, unknown>)._source === 'worker-router') return false;

    const type = message.type;
    if (typeof type !== 'string') return false;

    switch (type) {
      case 'CHANNEL_START_WORKER': { /* ... uses `storage` param ... */ }
      case 'CHANNEL_STOP_WORKER': { /* ... */ }
      case 'CHANNEL_ACK_OFFSET': { /* ... */ }
      case 'TRANSCRIBE_AUDIO': { /* ... */ }
      // ... all existing cases, unchanged logic
    }
    return false;
  });
};
```

Workers (telegram-worker, whatsapp-worker, stt-worker, tts-worker, text-gen-worker) are unchanged — still imported lazily inside switch cases.

When workers send results back, tag to prevent echo:
```typescript
chrome.runtime.sendMessage({ type: 'CHANNEL_UPDATES', _source: 'worker-router', ... });
```

---

### 5. EDIT: `pages/offscreen-channels/src/index.ts`

Refactor to thin wrapper that calls the extracted router:

```diff
 import './timer-shim';
+import { registerWorkerRouter } from './message-router';
 import { storageProxy } from './storage-proxy';
-import { startTelegramWorker, stopTelegramWorker, updateTelegramOffset } from './telegram-worker';
-
-// ... ~500 lines of onMessage handler ...
+
+// Baileys trace forwarder (stays here — specific to offscreen context)
+// ... console.log interceptor ...

-chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
-  // ... all message routing logic ...
-});
+registerWorkerRouter(storageProxy);

 console.log('[offscreen] Channel workers router initialized');
```

---

### 6. EDIT: `chrome-extension/src/background/tools/browser.ts`

**Change A** — Add import:
```diff
 import { cdpSend } from './cdp';
+import { IS_FIREFOX } from '@extension/env';
 import { sanitizeImage } from './image-sanitization';
```

**Change B** — Wrap debugger event listeners in `!IS_FIREFOX` guard (lines 185–254):
```diff
-chrome.debugger.onDetach.addListener((source, _reason) => {
-  ...
-});
-chrome.debugger.onEvent.addListener((source, method, params) => {
-  ...
-});
-chrome.tabs.onRemoved.addListener(tabId => {
-  ...
-});
+if (!IS_FIREFOX) {
+  chrome.debugger.onDetach.addListener((source, _reason) => { ... });
+  chrome.debugger.onEvent.addListener((source, method, params) => { ... });
+  chrome.tabs.onRemoved.addListener(tabId => { ... });
+}
```

**Change C** — Delegate `executeBrowser` to Firefox module:
```diff
 const executeBrowser = async (args: BrowserArgs): Promise<string | ScreenshotResult> => {
+  if (IS_FIREFOX) {
+    const { executeBrowserFirefox } = await import('./browser-firefox');
+    return executeBrowserFirefox(args);
+  }
   try {
     switch (args.action) {
```

---

### 7. EDIT: `chrome-extension/src/background/tools/index.ts`

Use the existing `excludeInHeadless` pattern — add a `chromeOnly` flag instead of an inline filter.

**Change A** — Add import:
```diff
+import { IS_FIREFOX } from '@extension/env';
```

**Change B** — Add `chromeOnly` check to the existing tool loop (line 129):
```diff
     if (!(config.enabledTools[def.name] ?? false)) continue;
     // Exclude headless-incompatible tools when in headless mode
     if (def.excludeInHeadless && opts?.headless) continue;
+    // Exclude Chrome-only tools when on Firefox
+    if (def.chromeOnly && IS_FIREFOX) continue;
```

**Change C** — Update `getImplementedToolNames` to also respect `chromeOnly`:
```diff
-const getImplementedToolNames = (): Set<string> => new Set(schemaLookup.keys());
+const getImplementedToolNames = (): Set<string> => {
+  const names = new Set(schemaLookup.keys());
+  if (IS_FIREFOX) {
+    for (const t of ALL_TOOLS) {
+      if (t.chromeOnly) names.delete(t.name);
+    }
+  }
+  return names;
+};
```

**Change D** — In `tool-registration.ts`, add `chromeOnly` to `ToolRegistration` interface:
```diff
 interface ToolRegistration {
   name: string;
   ...
   excludeInHeadless?: boolean;
+  chromeOnly?: boolean;
 }
```

**Change E** — In `debugger.ts`, set the flag on `debuggerToolDef`:
```diff
 const debuggerToolDef: ToolRegistration = {
   name: 'debugger',
+  chromeOnly: true,
   ...
 };
```

---

### 8. EDIT: `chrome-extension/src/background/tools/google-auth.ts`

Use **feature detection** for `removeCachedAuthToken` and `getAuthToken` — no `IS_FIREFOX` needed for those. Only keep `IS_FIREFOX` for the one piece of genuine business logic (error message).

**Change A** — Add import:
```diff
 import { createLogger } from '../logging/logger-buffer';
+import { IS_FIREFOX } from '@extension/env';
 import { toolConfigStorage } from '@extension/storage';
```

**Change B** — In `getGoogleToken()`, throw when Firefox has no custom client ID:
```diff
 const getGoogleToken = async (scopes: string[], interactive = true): Promise<string> => {
   const customClientId = await getGoogleClientId();
+
+  // Firefox has no manifest oauth2, so getAuthToken() won't work
+  if (IS_FIREFOX && !customClientId) {
+    throw new Error(
+      'Google tools require a custom OAuth Client ID on Firefox. ' +
+      'Configure it in Settings → Tools → Google.'
+    );
+  }
+
   const authPath = customClientId ? 'webAuthFlow' : 'getAuthToken';
```

**Change C** — In `removeCachedToken()`, use feature detection (no `IS_FIREFOX`):
```diff
   // Remove from Chrome's built-in cache (not available on all browsers)
-  await chrome.identity.removeCachedAuthToken({ token });
+  if (typeof chrome.identity?.removeCachedAuthToken === 'function') {
+    await chrome.identity.removeCachedAuthToken({ token });
+  }
```

**Change D** — In `revokeGoogleAccess()`, use feature detection (no `IS_FIREFOX`):
```diff
   webAuthTokenCache.clear();

-  // Clear Chrome's built-in cache
-  try {
-    const result = await chrome.identity.getAuthToken({ interactive: false });
-    ...
-  } catch {
-    // No token cached
-  }
+  // Clear Chrome's built-in cache (API may not exist on all browsers)
+  if (typeof chrome.identity?.getAuthToken === 'function') {
+    try {
+      const result = await chrome.identity.getAuthToken({ interactive: false });
+      const token = result.token;
+      if (!token) return;
+      if (typeof chrome.identity?.removeCachedAuthToken === 'function') {
+        await chrome.identity.removeCachedAuthToken({ token });
+      }
+      await fetch('https://accounts.google.com/o/oauth2/revoke', {
+        method: 'POST',
+        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
+        body: `token=${token}`,
+      }).catch(() => {});
+    } catch {
+      // No token cached
+    }
+  }
```

---

### 9. EDIT: `chrome-extension/src/background/channels/offscreen-manager.ts`

Use an **`OffscreenBackend` interface** to eliminate branching from business logic. `IS_FIREFOX` appears **once** at module init to select the backend.

**Change A** — Add import + define backend interface:
```diff
+import { IS_FIREFOX } from '@extension/env';
+
+interface OffscreenBackend {
+  ensure(): Promise<void>;
+  isAlive(): Promise<boolean>;
+  close(): Promise<void>;
+}
```

**Change B** — Chrome backend (wraps existing `chrome.offscreen` calls):
```typescript
const chromeBackend: OffscreenBackend = {
  ensure: async () => {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) return;
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_URL),
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: 'Long-poll connection for channel messaging',
    });
    offscreenLog.info('Offscreen document created');
  },
  isAlive: () => chrome.offscreen.hasDocument(),
  close: async () => {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) {
      await chrome.offscreen.closeDocument();
      offscreenLog.info('Offscreen document closed');
    }
  },
};
```

**Change C** — Firefox backend (imports shared router into background page):
```typescript
let routerLoaded = false;
const firefoxBackend: OffscreenBackend = {
  ensure: async () => {
    if (routerLoaded) return;
    const { registerWorkerRouter } = await import(
      '../../../../pages/offscreen-channels/src/message-router'
    );
    registerWorkerRouter({
      get: (keys) => chrome.storage.local.get(keys),
      set: (items) => chrome.storage.local.set(items),
      remove: (keys) => chrome.storage.local.remove(keys),
    });
    routerLoaded = true;
    offscreenLog.info('Firefox worker router loaded in background page');
  },
  isAlive: async () => true,  // background page is persistent
  close: async () => {},       // nothing to close
};
```

**Change D** — Select backend once, use everywhere (single `IS_FIREFOX` check):
```typescript
const backend: OffscreenBackend = IS_FIREFOX ? firefoxBackend : chromeBackend;
```

**Change E** — Rewrite functions to use `backend` (no branching):
```typescript
const ensureOffscreenDocument = () => backend.ensure();

const maybeCloseOffscreenDocument = async (): Promise<void> => {
  const configs = await getChannelConfigs();
  if (configs.some(c => c.status === 'active')) return;
  await backend.close();
  await chrome.alarms.clear(WATCHDOG_ALARM);
};

// In handleWatchdogAlarm:
if (hasActiveChannels) {
  const exists = await backend.isAlive();
  if (!exists) { /* re-create */ }
}
```

**Change F** — Update sender check in `chrome-extension/src/background/index.ts` (line 468):
```diff
     const isFromOffscreen =
-      sender.id === chrome.runtime.id && senderUrl.includes('offscreen-channels');
+      (sender.id === chrome.runtime.id && senderUrl.includes('offscreen-channels')) ||
+      (message as Record<string, unknown>)._source === 'worker-router';
```

Note: no `IS_FIREFOX` here — the `_source` tag works on both browsers. On Chrome the offscreen document never sets it, so the first branch matches. On Firefox, the router tags it.

---

### 10. EDIT: `chrome-extension/src/background/index.ts`

**Change A** — Replace sidePanel setup with utility (no `IS_FIREFOX`):
```diff
-chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
-  // Ignore errors in environments that don't support sidePanel
-});
+import { initSidePanelBehavior } from '@extension/shared';
+initSidePanelBehavior();
```

**Change B** — Use keep-alive utility (no `IS_FIREFOX`):
```diff
+import { createKeepAliveManager } from './utils/keep-alive';
+
-const KEEP_ALIVE_ALARM = 'keep-alive';
-let activeStreams = 0;
+const streamKeepAlive = createKeepAliveManager('keep-alive');

 chrome.runtime.onConnect.addListener(port => {
   if (port.name === 'llm-stream') {
-    activeStreams++;
-    if (activeStreams === 1) {
-      chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.4 });
-    }
+    streamKeepAlive.acquire();

     port.onDisconnect.addListener(() => {
-      activeStreams = Math.max(0, activeStreams - 1);
-      if (activeStreams === 0) {
-        chrome.alarms.clear(KEEP_ALIVE_ALARM);
-      }
+      streamKeepAlive.release();
     });
```

---

### 11. EDIT: `chrome-extension/src/background/tools/subagent.ts`

**Change** — Use keep-alive utility (no `IS_FIREFOX`):
```diff
+import { createKeepAliveManager } from '../utils/keep-alive';
-const SUBAGENT_KEEP_ALIVE_ALARM = 'subagent-keep-alive';
-let backgroundRunCount = 0;
-
-const acquireKeepAlive = (): void => {
-  backgroundRunCount++;
-  if (backgroundRunCount === 1) {
-    chrome.alarms.create(SUBAGENT_KEEP_ALIVE_ALARM, { periodInMinutes: 0.4 });
-  }
-};
-
-const releaseKeepAlive = (): void => {
-  backgroundRunCount = Math.max(0, backgroundRunCount - 1);
-  if (backgroundRunCount === 0) {
-    chrome.alarms.clear(SUBAGENT_KEEP_ALIVE_ALARM);
-  }
-};
+const subagentKeepAlive = createKeepAliveManager('subagent-keep-alive');
+const acquireKeepAlive = () => subagentKeepAlive.acquire();
+const releaseKeepAlive = () => subagentKeepAlive.release();
```

---

### 12. EDIT: `chrome-extension/src/background/channels/agent-handler.ts`

**Change** — Use keep-alive utility (no `IS_FIREFOX`):
```diff
+import { createKeepAliveManager } from '../utils/keep-alive';
-const CHANNEL_KEEP_ALIVE = 'channel-keep-alive';
-let activeChannelStreams = 0;
-chrome.alarms.clear(CHANNEL_KEEP_ALIVE);
-
-const acquireChannelKeepAlive = (): void => {
-  activeChannelStreams++;
-  if (activeChannelStreams === 1) {
-    chrome.alarms.create(CHANNEL_KEEP_ALIVE, { periodInMinutes: 0.4 });
-  }
-};
-
-const releaseChannelKeepAlive = (): void => {
-  activeChannelStreams = Math.max(0, activeChannelStreams - 1);
-  if (activeChannelStreams === 0) {
-    chrome.alarms.clear(CHANNEL_KEEP_ALIVE);
-  }
-};
+const channelKeepAlive = createKeepAliveManager('channel-keep-alive');
+channelKeepAlive.clearOrphan();
+const acquireChannelKeepAlive = () => channelKeepAlive.acquire();
+const releaseChannelKeepAlive = () => channelKeepAlive.release();
```

---

### 13. EDIT: `packages/storage/lib/base/base.ts`

**Change** — Feature detection for `setAccessLevel` (no `IS_FIREFOX`):
```diff
-    chrome?.storage[storageEnum]
-      .setAccessLevel({
-        accessLevel: SessionAccessLevelEnum.ExtensionPagesAndContentScripts,
-      })
-      .catch(error => {
-        console.error(error);
-        console.error(
-          'Please call .setAccessLevel() into different context, like a background script.',
-        );
-      });
+    if (typeof chrome?.storage[storageEnum]?.setAccessLevel === 'function') {
+      chrome.storage[storageEnum]
+        .setAccessLevel({
+          accessLevel: SessionAccessLevelEnum.ExtensionPagesAndContentScripts,
+        })
+        .catch(error => {
+          console.error(error);
+          console.error(
+            'Please call .setAccessLevel() into different context, like a background script.',
+          );
+        });
+    }
```

---

### 14. EDIT: `packages/config-panels/lib/session-manager.tsx`

**Change** — Use shared utility (no `IS_FIREFOX`):
```diff
+import { openSidePanel } from '@extension/shared';
 ...
       await lastActiveSessionStorage.set(chatId);
-      await chrome.sidePanel.open({});
+      await openSidePanel();
```

---

### 15. EDIT: `chrome-extension/manifest.ts`

**Change** — Add `sidebar_action` for Firefox sidebar support:
```diff
   side_panel: {
     default_path: 'side-panel/index.html',
   },
+  sidebar_action: {
+    default_panel: 'side-panel/index.html',
+    default_title: '__MSG_extensionName__',
+  },
 } satisfies ManifestType;
```

(The manifest parser already strips `side_panel` for Firefox and preserves `sidebar_action`.)

---

### 16. EDIT: `chrome-extension/src/background/tools/debugger.ts` + `tool-registration.ts`

**Change A** — Add `chromeOnly` to `ToolRegistration` interface in `tool-registration.ts`:
```diff
 interface ToolRegistration {
   name: string;
   ...
   excludeInHeadless?: boolean;
+  chromeOnly?: boolean;
 }
```

**Change B** — Set flag on `debuggerToolDef` in `debugger.ts`:
```diff
 const debuggerToolDef: ToolRegistration = {
   name: 'debugger',
+  chromeOnly: true,
   ...
 };
```

---

## `IS_FIREFOX` Audit

| Location | Count | Justification |
|----------|-------|---------------|
| `utils/keep-alive.ts` | 1 | Centralized: Firefox bg page is persistent, no keep-alive needed |
| `tools/browser.ts` | 2 | Unavoidable: guard top-level `chrome.debugger` listeners + dispatch to Firefox module |
| `tools/index.ts` | 2 | Filtering `chromeOnly` tools + `getImplementedToolNames` |
| `tools/google-auth.ts` | 1 | Business logic: Firefox-specific error message for missing client ID |
| `channels/offscreen-manager.ts` | 1 | Backend selection: `IS_FIREFOX ? firefoxBackend : chromeBackend` |
| **Total** | **7** | Down from ~25 in the original plan |

Everything else uses **feature detection** (`typeof api?.method === 'function'`) or **dependency injection** (storage interface, backend interface, keep-alive utility).

---

## Design Alignment Checklist

| Design Doc Item | Plan Section | Approach |
|----------------|-------------|----------|
| 1. `chrome.sidePanel` → `browser.sidebarAction` | §2 (side-panel.ts), §10 (index.ts), §14 (session-manager), §15 (manifest) | Feature detection utility |
| 2. `chrome.offscreen` → direct background page | §4 (message-router.ts), §5 (index.ts refactor), §9 (OffscreenBackend interface) | Dependency injection + backend interface |
| 3. `chrome.debugger` → scripting fallback | §3 (browser-firefox.ts), §6 (browser.ts guards), §7+§16 (chromeOnly flag) | Lazy import + tool flag |
| 4. `chrome.identity` → force `launchWebAuthFlow` | §8 (google-auth.ts) | Feature detection + 1× business logic check |
| 5. Keep-alive alarms → conditional skip | §1 (keep-alive.ts), §10–12 (consumers) | Centralized utility |
| 6. `storage.session.setAccessLevel` guard | §13 (base.ts) | Feature detection |
| 7. `declarativeNetRequest.testMatchOutcome` guard | Already has try/catch — no change needed | N/A |

---

## Verification

```bash
# 1. All Firefox-specific tests should pass:
pnpm vitest run chrome-extension/src/background/tools/browser-firefox.test.ts
pnpm vitest run chrome-extension/src/background/tools/browser-dispatch-firefox.test.ts
pnpm vitest run chrome-extension/src/background/tools/tool-definitions-firefox.test.ts
pnpm vitest run chrome-extension/src/background/tools/google-auth-firefox.test.ts
pnpm vitest run chrome-extension/src/background/channels/offscreen-manager.test.ts
pnpm vitest run packages/dev-utils/lib/manifest-parser/impl.test.ts

# 2. Existing tests still pass:
pnpm test

# 3. Firefox build succeeds:
pnpm build:firefox

# 4. Type-check:
pnpm type-check
```
