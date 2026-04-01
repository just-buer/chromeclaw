/**
 * Page Bridge — Web MCP-like protocol for discovering and calling
 * page-registered tool handlers via window.__ulcopilot.
 *
 * Pages register tools:
 *   window.__ulcopilot.registerTool('fill_form', {
 *     description: '...',
 *     params: [{ name: 'formData', type: 'object', description: '...' }],
 *     handler: async (args) => { ... }
 *   });
 *
 * The extension discovers them via chrome.scripting.executeScript and
 * exposes them as agent tools. Execution also goes through executeScript
 * with world: 'MAIN' — zero CDP.
 */

import { createLogger } from '../logging/logger-buffer';

const pageBridgeLog = createLogger('page-bridge');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageToolDef {
  name: string;
  description: string;
  params: { name: string; type: string; description: string }[];
  requiresApproval?: boolean;
}

// ---------------------------------------------------------------------------
// Discovery — read window.__ulcopilot.tools from a tab
// ---------------------------------------------------------------------------

const discoverPageTools = async (tabId: number): Promise<PageToolDef[]> => {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
      func: () => {
        const ul = (window as unknown as Record<string, unknown>).__ulcopilot as
          | { tools?: Record<string, { description?: string; params?: unknown[]; requiresApproval?: boolean }> }
          | undefined;
        if (!ul?.tools) return null;
        return Object.entries(ul.tools).map(([name, def]) => ({
          name,
          description: def.description ?? '',
          params: Array.isArray(def.params) ? def.params : [],
          requiresApproval: def.requiresApproval,
        }));
      },
    });

    const defs = results?.[0]?.result;
    return Array.isArray(defs) ? (defs as PageToolDef[]) : [];
  } catch (err) {
    pageBridgeLog.debug('Discovery failed', {
      tabId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
};

// ---------------------------------------------------------------------------
// Execution — call a page tool handler in the target tab
// ---------------------------------------------------------------------------

const executePageTool = async (
  tabId: number,
  toolName: string,
  args: unknown,
): Promise<string> => {
  try {
    await chrome.tabs.get(tabId);
  } catch {
    return `Error: Tab ${tabId} no longer exists. The page may have been closed or navigated away.`;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN' as chrome.scripting.ExecutionWorld,
      func: async (name: string, toolArgs: unknown) => {
        const ul = (window as unknown as Record<string, unknown>).__ulcopilot as
          | { tools?: Record<string, { handler?: (a: unknown) => Promise<unknown> }> }
          | undefined;
        const handler = ul?.tools?.[name]?.handler;
        if (!handler) return { __pageBridgeError: `Page tool "${name}" is no longer registered.` };
        try {
          const result = await handler(toolArgs);
          if (result === undefined) return { __pageBridgeOk: true };
          try {
            return JSON.parse(JSON.stringify(result));
          } catch {
            return { __pageBridgeOk: true, text: String(result) };
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { __pageBridgeError: msg };
        }
      },
      args: [toolName, args],
    });

    const res = results?.[0]?.result as Record<string, unknown> | undefined;
    if (!res) return 'Error: executeScript returned no result.';
    if (res.__pageBridgeError) return `Error: ${res.__pageBridgeError}`;
    if (res.__pageBridgeOk && res.text) return res.text as string;
    if (res.__pageBridgeOk) return 'OK';
    return typeof res === 'string' ? res : JSON.stringify(res);
  } catch (err) {
    return `Error executing page tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { discoverPageTools, executePageTool };
export type { PageToolDef };
