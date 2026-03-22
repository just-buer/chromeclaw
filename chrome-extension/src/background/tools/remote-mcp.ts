// ---------------------------------------------------------------------------
// Remote MCP — HTTP client for MCP servers + dynamic AgentTool factory.
//
// Supports two MCP HTTP transports:
//
//  1. Streamable HTTP (2025 spec, mcp-proxy default):
//       POST {baseUrl}/mcp  ← all JSON-RPC requests go here
//       Session management: first send "initialize" to get Mcp-Session-Id,
//       then include it as a header on all subsequent requests.
//
//  2. SSE (legacy spec, older servers):
//       GET  {baseUrl}/sse  ← establishes SSE stream, server sends endpoint URL
//       POST {endpointUrl}  ← send JSON-RPC, get result via SSE stream
//
// Auto-detection order: Streamable HTTP → SSE
// ---------------------------------------------------------------------------

import { mcpServersStorage } from '@extension/storage';
import { createLogger } from '../logging/logger-buffer';
import { defaultFormatResult } from './tool-registration';
import type { TObject } from '@sinclair/typebox';
import type { AgentTool } from '../agents';

const mcpLog = createLogger('tool');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type McpTransport = 'streamable-http' | 'sse' | 'auto';

// ---------------------------------------------------------------------------
// Caches — cleared whenever server config changes
// ---------------------------------------------------------------------------

/** serverId → discovered tool list */
const toolCache = new Map<string, McpTool[]>();

/** baseUrl → active Mcp-Session-Id (Streamable HTTP) */
const sessionCache = new Map<string, string>();

/** baseUrl → in-flight initialize promise (prevents duplicate handshakes) */
const initFlight = new Map<string, Promise<string | undefined>>();

mcpServersStorage.subscribe(() => {
  toolCache.clear();
  sessionCache.clear();
  mcpLog.debug('MCP caches cleared (server config changed)');
});

// ---------------------------------------------------------------------------
// Streamable HTTP transport  (POST {baseUrl}/mcp)
// ---------------------------------------------------------------------------

const MCP_PATH = '/mcp';

async function parseStreamableResponse(res: Response): Promise<JsonRpcResponse> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const p = JSON.parse(line.slice(6)) as JsonRpcResponse;
          if (p.result !== undefined || p.error !== undefined) return p;
        } catch { /* skip */ }
      }
    }
    throw new Error('No JSON-RPC result in SSE response body');
  }
  return res.json() as Promise<JsonRpcResponse>;
}

/** Send the MCP initialize handshake and return the session ID (if any). */
async function initializeStreamable(
  endpoint: string,
  authHeaders: Record<string, string>,
): Promise<string | undefined> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...authHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'chromeclaw', version: '1.0' },
      },
    }),
  });

  if (!res.ok) throw new Error(`MCP initialize failed: HTTP ${res.status} ${res.statusText}`);
  await res.body?.cancel(); // drain body
  return res.headers.get('mcp-session-id') ?? undefined;
}

/** Get (or lazily create) a session ID for the given base URL. */
async function getSession(
  baseUrl: string,
  authHeaders: Record<string, string>,
): Promise<string | undefined> {
  const cached = sessionCache.get(baseUrl);
  if (cached) return cached;

  // Deduplicate concurrent initialize calls
  let flight = initFlight.get(baseUrl);
  if (!flight) {
    const endpoint = baseUrl.replace(/\/+$/, '') + MCP_PATH;
    flight = initializeStreamable(endpoint, authHeaders).then(id => {
      if (id) sessionCache.set(baseUrl, id);
      initFlight.delete(baseUrl);
      return id;
    }).catch(err => {
      initFlight.delete(baseUrl);
      throw err;
    });
    initFlight.set(baseUrl, flight);
  }
  return flight;
}

async function sendStreamableHTTP(
  baseUrl: string,
  method: string,
  params: unknown,
  apiKey?: string,
): Promise<JsonRpcResponse> {
  const endpoint = baseUrl.replace(/\/+$/, '') + MCP_PATH;
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  const sessionId = await getSession(baseUrl, authHeaders);

  const doPost = (sid?: string) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sid ? { 'Mcp-Session-Id': sid } : {}),
        ...authHeaders,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
    });

  let res = await doPost(sessionId);

  // Session expired or invalid — reinitialize once
  if (!res.ok || (res.status === 200 && res.headers.get('content-type')?.includes('application/json'))) {
    let json: JsonRpcResponse | null = null;
    if (res.ok) {
      json = await res.json() as JsonRpcResponse;
    }
    const isSessionError =
      !res.ok ||
      (json?.error && json.error.code === -32000 && /session/i.test(json.error.message));

    if (isSessionError) {
      sessionCache.delete(baseUrl);
      const newSession = await getSession(baseUrl, authHeaders);
      res = await doPost(newSession);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return parseStreamableResponse(res);
    }
    if (json) return json;
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return parseStreamableResponse(res);
}

// ---------------------------------------------------------------------------
// SSE transport  (GET {baseUrl}/sse  then POST {endpointUrl})
// ---------------------------------------------------------------------------

async function sendSSE(
  baseUrl: string,
  method: string,
  params: unknown,
  apiKey?: string,
): Promise<JsonRpcResponse> {
  const base = baseUrl.replace(/\/+$/, '');
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  // 1. Connect to SSE endpoint
  const sseRes = await fetch(`${base}/sse`, { headers: authHeaders });
  if (!sseRes.ok) throw new Error(`SSE connect failed: HTTP ${sseRes.status} at ${base}/sse`);
  if (!sseRes.body) throw new Error('SSE response body is null');

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventType = '';
  let endpointUrl: string | null = null;

  // 2. Read until "endpoint" event
  while (!endpointUrl) {
    const { done, value } = await reader.read();
    if (done) throw new Error('SSE stream closed before endpoint event');
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line === '') {
        eventType = '';
      } else if (line.startsWith('data: ') && eventType === 'endpoint') {
        let ep = line.slice(6).trim();
        if (ep.startsWith('/')) {
          const u = new URL(baseUrl);
          ep = `${u.protocol}//${u.host}${ep}`;
        }
        endpointUrl = ep;
      }
    }
  }

  // 3. POST the JSON-RPC message
  const postRes = await fetch(endpointUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
  });
  if (!postRes.ok) {
    void reader.cancel();
    throw new Error(`SSE message POST failed: HTTP ${postRes.status}`);
  }

  // 4. Read the result event
  eventType = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error('SSE stream closed before result');
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line === '') {
        eventType = '';
      } else if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6)) as JsonRpcResponse;
          if (parsed.id === 1 && (parsed.result !== undefined || parsed.error !== undefined)) {
            void reader.cancel();
            return parsed;
          }
        } catch { /* skip non-JSON */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-detecting dispatcher
// ---------------------------------------------------------------------------

async function sendMcpRequest(
  baseUrl: string,
  method: string,
  params: unknown,
  apiKey?: string,
  transport: McpTransport = 'auto',
): Promise<JsonRpcResponse> {
  if (transport === 'sse') return sendSSE(baseUrl, method, params, apiKey);
  if (transport === 'streamable-http') return sendStreamableHTTP(baseUrl, method, params, apiKey);

  // auto: try Streamable HTTP at /mcp, fall back to SSE
  try {
    return await sendStreamableHTTP(baseUrl, method, params, apiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only fall back on HTTP-level failures (not logic errors from within)
    if (/HTTP 4\d\d|initialize failed|SSE/.test(msg)) {
      mcpLog.debug(`Streamable HTTP failed (${msg}), retrying with SSE transport`);
      return sendSSE(baseUrl, method, params, apiKey);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listMcpTools(
  url: string,
  apiKey?: string,
  transport: McpTransport = 'auto',
): Promise<McpTool[]> {
  const response = await sendMcpRequest(url, 'tools/list', {}, apiKey, transport);
  if (response.error) throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
  return (response.result as { tools?: McpTool[] })?.tools ?? [];
}

export async function callMcpTool(
  url: string,
  toolName: string,
  args: unknown,
  apiKey?: string,
  transport: McpTransport = 'auto',
): Promise<string> {
  const response = await sendMcpRequest(
    url,
    'tools/call',
    { name: toolName, arguments: args },
    apiKey,
    transport,
  );
  if (response.error) throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
  const result = response.result as
    | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
    | undefined;
  const text = (result?.content ?? [])
    .map(c => c.text ?? '')
    .filter(Boolean)
    .join('\n');
  if (result?.isError) return `Error: ${text}`;
  return text || JSON.stringify(result);
}

// ---------------------------------------------------------------------------
// AgentTool factory — called from tools/index.ts > getAgentTools()
// ---------------------------------------------------------------------------

export async function getRemoteMcpAgentTools(): Promise<AgentTool[]> {
  const servers = await mcpServersStorage.get();
  const enabled = servers.filter(s => s.enabled);
  if (enabled.length === 0) return [];

  const perServer = await Promise.allSettled(
    enabled.map(async server => {
      let tools = toolCache.get(server.id);
      if (!tools) {
        const t = (server.transport ?? 'auto') as McpTransport;
        tools = await listMcpTools(server.url, server.apiKey, t);
        toolCache.set(server.id, tools);
        mcpLog.debug(`Cached ${tools.length} tools from MCP server "${server.name}"`);
      }

      return tools.map(
        (tool): AgentTool & { requiresApproval?: boolean } => ({
          name: tool.name,
          label: `[${server.name}] ${tool.name}`,
          description: tool.description ?? tool.name,
          parameters: tool.inputSchema as unknown as TObject,
          requiresApproval:
            server.toolApprovalOverrides?.[tool.name] ??
            server.requireApproval ??
            false,
          execute: async (_toolCallId, params) => {
            try {
              const t = (server.transport ?? 'auto') as McpTransport;
              const text = await callMcpTool(server.url, tool.name, params, server.apiKey, t);
              return defaultFormatResult(text);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              mcpLog.warn(`MCP tool "${tool.name}" failed`, { server: server.name, error: msg });
              return defaultFormatResult(
                `Error calling "${tool.name}" on MCP server "${server.name}": ${msg}`,
              );
            }
          },
        }),
      );
    }),
  );

  const tools: AgentTool[] = [];
  for (let i = 0; i < perServer.length; i++) {
    const outcome = perServer[i];
    if (outcome.status === 'fulfilled') {
      tools.push(...outcome.value);
    } else {
      const reason =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      mcpLog.warn(`Skipping MCP server "${enabled[i].name}" — could not load tools`, {
        error: reason,
      });
    }
  }

  return tools;
}

export function invalidateMcpToolCache(serverId?: string): void {
  if (serverId) {
    toolCache.delete(serverId);
  } else {
    toolCache.clear();
  }
}
