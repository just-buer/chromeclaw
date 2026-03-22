import { mcpServersStorage } from '@extension/storage';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@extension/ui';
import {
  CheckCircleIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
  XCircleIcon,
} from 'lucide-react';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useState } from 'react';
import type { McpServerConfig } from '@extension/storage';

// ---------------------------------------------------------------------------
// MCP fetch helpers (run directly in the options page context)
// ---------------------------------------------------------------------------

interface McpToolInfo {
  name: string;
  description?: string;
}

type Transport = 'auto' | 'streamable-http' | 'sse';

// SSE transport: GET /sse → receive endpoint URL → POST → read result from stream
async function fetchMcpToolsSSE(base: string, apiKey?: string): Promise<McpToolInfo[]> {
  const url = base.replace(/\/+$/, '') + '/sse';
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  const sseRes = await fetch(url, { headers });
  if (!sseRes.ok) throw new Error(`SSE connect failed: HTTP ${sseRes.status}`);
  if (!sseRes.body) throw new Error('SSE response has no body');

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventType = '';
  let endpointUrl: string | null = null;

  while (!endpointUrl) {
    const { done, value } = await reader.read();
    if (done) throw new Error('SSE stream closed before endpoint event');
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event: ')) { eventType = line.slice(7).trim(); }
      else if (line === '') { eventType = ''; }
      else if (line.startsWith('data: ') && eventType === 'endpoint') {
        let ep = line.slice(6).trim();
        if (ep.startsWith('/')) { const u = new URL(base); ep = `${u.protocol}//${u.host}${ep}`; }
        endpointUrl = ep;
      }
    }
  }

  const authHeaders: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
  const postRes = await fetch(endpointUrl, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  if (!postRes.ok) { void reader.cancel(); throw new Error(`Message POST failed: HTTP ${postRes.status}`); }

  eventType = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error('SSE stream closed before result');
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event: ')) { eventType = line.slice(7).trim(); }
      else if (line === '') { eventType = ''; }
      else if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.id === 1 && (parsed.result !== undefined || parsed.error !== undefined)) {
            void reader.cancel();
            if (parsed.error) throw new Error(parsed.error.message);
            return (parsed.result?.tools as McpToolInfo[]) ?? [];
          }
        } catch (e) { if (e instanceof Error && e.message !== 'Unexpected token') throw e; }
      }
    }
  }
}

// Streamable HTTP transport: POST /mcp with initialize → get session ID → POST /mcp with tools/list
async function fetchMcpToolsStreamable(baseUrl: string, apiKey?: string): Promise<McpToolInfo[]> {
  const endpoint = baseUrl.replace(/\/+$/, '') + '/mcp';
  const authHeaders: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const commonHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...authHeaders,
  };

  // Step 1: initialize → get Mcp-Session-Id
  const initRes = await fetch(endpoint, {
    method: 'POST',
    headers: commonHeaders,
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
  if (!initRes.ok) throw new Error(`Initialize failed: HTTP ${initRes.status} ${initRes.statusText}`);
  const sessionId = initRes.headers.get('mcp-session-id');
  await initRes.body?.cancel();

  // Step 2: tools/list with session ID
  const listRes = await fetch(endpoint, {
    method: 'POST',
    headers: { ...commonHeaders, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  if (!listRes.ok) throw new Error(`HTTP ${listRes.status}: ${listRes.statusText}`);

  const ct = listRes.headers.get('content-type') ?? '';
  let json: { result?: { tools?: McpToolInfo[] }; error?: { message: string } };
  if (ct.includes('text/event-stream')) {
    const text = await listRes.text();
    let found: typeof json | null = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const p = JSON.parse(line.slice(6));
          if (p.result !== undefined || p.error !== undefined) { found = p; break; }
        } catch { /* skip */ }
      }
    }
    if (!found) throw new Error('No result in SSE response');
    json = found;
  } else {
    json = await listRes.json();
  }
  if (json.error) throw new Error(json.error.message);
  return json.result?.tools ?? [];
}

async function fetchMcpTools(
  url: string,
  apiKey?: string,
  transport: Transport = 'auto',
): Promise<McpToolInfo[]> {
  if (transport === 'sse') return fetchMcpToolsSSE(url, apiKey);
  if (transport === 'streamable-http') return fetchMcpToolsStreamable(url, apiKey);
  // auto: Streamable HTTP first (handles /mcp + session), fall back to SSE
  try {
    return await fetchMcpToolsStreamable(url, apiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 4\d\d|Initialize failed/.test(msg)) return fetchMcpToolsSSE(url, apiKey);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Server form dialog
// ---------------------------------------------------------------------------

interface ServerFormData {
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
  transport: Transport;
  requireApproval: boolean;
  toolApprovalOverrides: Record<string, boolean>;
}

const emptyForm: ServerFormData = {
  name: '',
  url: '',
  apiKey: '',
  enabled: true,
  transport: 'auto',
  requireApproval: false,
  toolApprovalOverrides: {},
};

const ServerDialog = ({
  open,
  onClose,
  initial,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  initial?: McpServerConfig;
  onSave: (data: ServerFormData & { id?: string }) => void;
}) => {
  const [form, setForm] = useState<ServerFormData>(
    initial
      ? {
          name: initial.name,
          url: initial.url,
          apiKey: initial.apiKey ?? '',
          enabled: initial.enabled,
          transport: (initial.transport ?? 'auto') as Transport,
          requireApproval: initial.requireApproval ?? false,
          toolApprovalOverrides: initial.toolApprovalOverrides ?? {},
        }
      : emptyForm,
  );
  const [error, setError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testTools, setTestTools] = useState<McpToolInfo[]>([]);

  useEffect(() => {
    if (open) {
      setForm(
        initial
          ? {
              name: initial.name,
              url: initial.url,
              apiKey: initial.apiKey ?? '',
              enabled: initial.enabled,
              transport: (initial.transport ?? 'auto') as Transport,
              requireApproval: initial.requireApproval ?? false,
              toolApprovalOverrides: initial.toolApprovalOverrides ?? {},
            }
          : emptyForm,
      );
      setError(null);
      setTestStatus('idle');
      setTestTools([]);
    }
  }, [open, initial]);

  const set = (key: keyof ServerFormData, value: string | boolean) => {
    setForm(prev => ({ ...prev, [key]: value }));
    if (key === 'url' || key === 'transport') setTestStatus('idle');
  };

  const handleTest = useCallback(async () => {
    if (!form.url.trim()) { setError('URL is required'); return; }
    setTestStatus('testing');
    setError(null);
    try {
      const tools = await fetchMcpTools(
        form.url.trim(),
        form.apiKey.trim() || undefined,
        form.transport,
      );
      setTestTools(tools);
      setTestStatus('ok');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTestStatus('fail');
    }
  }, [form.url, form.apiKey, form.transport]);

  const handleSave = () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    if (!form.url.trim()) { setError('URL is required'); return; }
    try { new URL(form.url.trim()); } catch { setError('Invalid URL'); return; }
    onSave({ ...form, url: form.url.trim(), id: initial?.id });
  };
  return (
    <Dialog onOpenChange={o => !o && onClose()} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit MCP Server' : 'Add MCP Server'}</DialogTitle>
          <DialogDescription>
            Connect to any MCP-compatible server. Supports Streamable HTTP and SSE transport.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              onChange={e => set('name', e.target.value)}
              placeholder="Chrome DevTools"
              value={form.name}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="mcp-url">Base URL</Label>
            <Input
              id="mcp-url"
              onChange={e => set('url', e.target.value)}
              placeholder="http://localhost:3000"
              value={form.url}
            />
            <p className="text-muted-foreground text-xs">
              Base URL only — no path needed.{' '}
              <code className="bg-muted rounded px-1 font-mono text-xs">
                npx mcp-proxy --port 3000 -- npx chrome-devtools-mcp --auto-connect
              </code>
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="mcp-transport">Transport</Label>
            <Select
              onValueChange={v => set('transport', v as Transport)}
              value={form.transport}>
              <SelectTrigger id="mcp-transport">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto-detect (Streamable HTTP → SSE)</SelectItem>
                <SelectItem value="streamable-http">Streamable HTTP — mcp-proxy / newer servers</SelectItem>
                <SelectItem value="sse">SSE — legacy servers</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="mcp-apikey">API Key (optional)</Label>
            <Input
              id="mcp-apikey"
              onChange={e => set('apiKey', e.target.value)}
              placeholder="Bearer token…"
              type="password"
              value={form.apiKey}
            />
          </div>

          {testStatus === 'ok' && (
            <div className="bg-accent/50 text-accent-foreground rounded-md border p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <CheckCircleIcon className="text-primary size-4" />
                Connected — {testTools.length} tool{testTools.length !== 1 ? 's' : ''} available
              </div>

              {/* Server-level default approval toggle */}
              <div className="mb-2 flex items-center justify-between">
                <span className="text-muted-foreground text-xs">All tools require approval (default)</span>
                <input
                  checked={form.requireApproval}
                  className="accent-yellow-500 size-4 cursor-pointer"
                  onChange={e => setForm(prev => ({ ...prev, requireApproval: e.target.checked }))}
                  type="checkbox"
                />
              </div>

              {/* Per-tool overrides */}
              {testTools.length > 0 && (
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {testTools.map(t => {
                    const override = form.toolApprovalOverrides[t.name];
                    const effective = override ?? form.requireApproval;
                    return (
                      <div key={t.name} className="flex items-center justify-between gap-2">
                        <Badge className="font-mono text-xs" variant="secondary">
                          {t.name}
                        </Badge>
                        <div className="flex items-center gap-1">
                          <input
                            checked={effective}
                            className="accent-yellow-500 size-3.5 cursor-pointer"
                            onChange={e => {
                              const val = e.target.checked;
                              setForm(prev => ({
                                ...prev,
                                toolApprovalOverrides: {
                                  ...prev.toolApprovalOverrides,
                                  [t.name]: val,
                                },
                              }));
                            }}
                            title={override !== undefined ? 'Override' : 'Inherits server default'}
                            type="checkbox"
                          />
                          {override !== undefined && (
                            <button
                              className="text-muted-foreground hover:text-foreground text-xs underline"
                              onClick={() => {
                                setForm(prev => {
                                  const overrides = { ...prev.toolApprovalOverrides };
                                  delete overrides[t.name];
                                  return { ...prev, toolApprovalOverrides: overrides };
                                });
                              }}
                              title="Reset to server default"
                              type="button">
                              ↺
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {testStatus === 'fail' && error && (
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border p-3 text-sm">
              <XCircleIcon className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {testStatus !== 'fail' && error && (
            <p className="text-destructive text-sm">{error}</p>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            className="sm:mr-auto"
            disabled={testStatus === 'testing'}
            onClick={handleTest}
            variant="outline">
            {testStatus === 'testing' ? (
              <><Loader2Icon className="mr-2 size-4 animate-spin" />Testing…</>
            ) : (
              'Test Connection'
            )}
          </Button>
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button onClick={handleSave}>{initial ? 'Save Changes' : 'Add Server'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Main McpConfig panel
// ---------------------------------------------------------------------------

const McpConfig = () => {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<McpServerConfig | undefined>(undefined);

  useEffect(() => {
    mcpServersStorage.get().then(setServers);
    const unsub = mcpServersStorage.subscribe(() => {
      mcpServersStorage.get().then(setServers);
    });
    return unsub;
  }, []);

  const persist = async (updated: McpServerConfig[]) => {
    setServers(updated);
    await mcpServersStorage.set(updated);
  };

  const handleSave = async (data: {
    id?: string;
    name: string;
    url: string;
    apiKey: string;
    enabled: boolean;
    transport: Transport;
    requireApproval: boolean;
    toolApprovalOverrides: Record<string, boolean>;
  }) => {
    const transport = data.transport === 'auto' ? undefined : data.transport;
    const requireApproval = data.requireApproval || undefined;
    const toolApprovalOverrides =
      Object.keys(data.toolApprovalOverrides).length > 0 ? data.toolApprovalOverrides : undefined;
    if (data.id) {
      await persist(
        servers.map(s =>
          s.id === data.id
            ? { ...s, name: data.name, url: data.url, apiKey: data.apiKey || undefined, enabled: data.enabled, transport, requireApproval, toolApprovalOverrides }
            : s,
        ),
      );
    } else {
      await persist([
        ...servers,
        { id: nanoid(), name: data.name, url: data.url, apiKey: data.apiKey || undefined, enabled: data.enabled, transport, requireApproval, toolApprovalOverrides },
      ]);
    }
    setDialogOpen(false);
    setEditTarget(undefined);
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    await persist(servers.map(s => (s.id === id ? { ...s, enabled } : s)));
  };

  const handleDelete = async (id: string) => {
    await persist(servers.filter(s => s.id !== id));
  };

  const openAdd = () => { setEditTarget(undefined); setDialogOpen(true); };
  const openEdit = (s: McpServerConfig) => { setEditTarget(s); setDialogOpen(true); };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ServerIcon className="size-5" />
                MCP Servers
              </CardTitle>
              <CardDescription className="mt-1">
                Connect to external MCP-compatible tool servers. Tools are automatically exposed to
                the agent when the server is enabled.
              </CardDescription>
            </div>
            <Button onClick={openAdd} size="sm" variant="outline">
              <PlusIcon className="mr-2 size-4" />
              Add Server
            </Button>
          </div>
        </CardHeader>

        <CardContent>
          {servers.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-3 py-8 text-center">
              <ServerIcon className="size-10 opacity-30" />
              <div>
                <p className="text-sm font-medium">No MCP servers configured</p>
                <p className="mt-1 text-xs">
                  Start a server, then add it here:
                  <br />
                  <code className="bg-muted mt-1 inline-block rounded px-1.5 py-0.5 font-mono text-xs">
                    npx mcp-proxy --port 3000 -- npx chrome-devtools-mcp --auto-connect
                  </code>
                </p>
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              {servers.map(server => (
                <div
                  className="flex items-center justify-between rounded-md border p-3"
                  key={server.id}>
                  <div className="flex items-center gap-3">
                    <input
                      checked={server.enabled}
                      className="accent-primary size-4"
                      id={`mcp-toggle-${server.id}`}
                      onChange={e => handleToggle(server.id, e.target.checked)}
                      type="checkbox"
                    />
                    <div>
                      <Label
                        className="cursor-pointer text-sm font-medium"
                        htmlFor={`mcp-toggle-${server.id}`}>
                        {server.name}
                      </Label>
                      <p className="text-muted-foreground font-mono text-xs">
                        {server.url}
                        {server.transport && (
                          <span className="ml-1.5 font-sans opacity-60">[{server.transport}]</span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Badge variant={server.enabled ? 'default' : 'secondary'}>
                      {server.enabled ? 'Active' : 'Disabled'}
                    </Badge>
                    <Button onClick={() => openEdit(server)} size="icon" variant="ghost">
                      <PencilIcon className="size-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="icon" variant="ghost">
                          <Trash2Icon className="size-4 text-red-500" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove MCP Server</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to remove <strong>{server.name}</strong>? This
                            will also remove its tools from the agent.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => handleDelete(server.id)}>
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ServerDialog
        initial={editTarget}
        onClose={() => { setDialogOpen(false); setEditTarget(undefined); }}
        onSave={handleSave}
        open={dialogOpen}
      />
    </>
  );
};

export { McpConfig };
