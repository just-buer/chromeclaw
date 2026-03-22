import { createStorage, StorageEnum } from '../base/index.js';

interface McpServerConfig {
  id: string;
  /** Display name shown in the UI */
  name: string;
  /** Base URL of the MCP server, e.g. http://localhost:3000 */
  url: string;
  /** Optional bearer token sent as Authorization header */
  apiKey?: string;
  /** Whether this server's tools are active */
  enabled: boolean;
  /**
   * Transport protocol. Leave undefined for auto-detection:
   *   tries Streamable HTTP first, falls back to SSE (used by mcp-proxy).
   */
  transport?: 'streamable-http' | 'sse';
  /** When true, all tools on this server require user approval before execution (default: false). */
  requireApproval?: boolean;
  /** Per-tool approval overrides. Key = tool name. Overrides requireApproval when set. */
  toolApprovalOverrides?: Record<string, boolean>;
}

export const mcpServersStorage = createStorage<McpServerConfig[]>('mcp-servers', [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type { McpServerConfig };
