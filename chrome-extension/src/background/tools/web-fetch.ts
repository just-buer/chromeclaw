// ---------------------------------------------------------------------------
// web_fetch tool — fetch and extract content from a URL.
// ---------------------------------------------------------------------------

import { normalizeCacheKey, readCache, writeCache, withTimeout } from './web-shared';
import { createLogger } from '../logging/logger-buffer';
import { Type } from '@sinclair/typebox';
import type { CacheEntry } from './web-shared';
import type { Static } from '@sinclair/typebox';

const log = createLogger('tool');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const webFetchSchema = Type.Object({
  url: Type.String({ description: 'The URL to fetch content from' }),
  method: Type.Optional(
    Type.Union([Type.Literal('GET'), Type.Literal('POST')], {
      description: 'HTTP method (default: GET)',
    }),
  ),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'Custom request headers (e.g. Content-Type, Authorization)',
    }),
  ),
  body: Type.Optional(
    Type.String({ description: 'Request body (typically JSON string for POST requests)' }),
  ),
  extractMode: Type.Optional(
    Type.Union([Type.Literal('text'), Type.Literal('html'), Type.Literal('binary')], {
      description:
        'Extraction mode: "text" strips HTML (default), "html" returns raw, "binary" returns base64 data URI for images/files',
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({ description: 'Maximum characters to return (default: 30000)' }),
  ),
});

type WebFetchArgs = Static<typeof webFetchSchema>;

interface WebFetchResult {
  text: string;
  title?: string;
  status: number;
  mimeType?: string;
  sizeBytes?: number;
  isBase64?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const FETCH_CACHE = new Map<string, CacheEntry<WebFetchResult>>();
const CACHE_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 30_000;
const BINARY_DEFAULT_MAX_CHARS = 2_000_000;
const BINARY_MAX_BYTES = 10_000_000; // 10 MB hard limit

// ---------------------------------------------------------------------------
// Base64 encoding — chunked to avoid stack overflow on large arrays
// ---------------------------------------------------------------------------

const uint8ToBase64 = (bytes: Uint8Array): string => {
  // Process in 3072-byte chunks (multiple of 3 → 4096 base64 chars each).
  // Encoding per-chunk avoids the O(n²) join + single btoa() on huge strings.
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3072) {
    const slice = bytes.subarray(i, i + 3072);
    let s = '';
    for (let j = 0; j < slice.length; j++) {
      s += String.fromCharCode(slice[j]!);
    }
    parts.push(btoa(s));
  }
  return parts.join('');
};

// ---------------------------------------------------------------------------
// HTML entity decoding
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '\u2013',
  '&mdash;': '\u2014',
  '&hellip;': '\u2026',
};

const decodeEntities = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(
      /&(?:amp|lt|gt|quot|#39|apos|nbsp|ndash|mdash|hellip);/g,
      match => HTML_ENTITIES[match] ?? match,
    );

// ---------------------------------------------------------------------------
// HTML → text extraction
// ---------------------------------------------------------------------------

const extractText = (html: string, maxChars: number): string => {
  let text = html;

  // Remove non-content elements entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Convert block elements to newlines for structure
  text = text.replace(/<\/(?:p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode entities
  text = decodeEntities(text);

  // Normalize whitespace
  text = text
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 15) // Filter short lines (nav items, labels)
    .join('\n');

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text.slice(0, maxChars);
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

const executeWebFetch = async (args: WebFetchArgs): Promise<WebFetchResult> => {
  const { url, method, headers, body, extractMode, maxChars = DEFAULT_MAX_CHARS } = args;
  const isPost = method === 'POST';
  log.trace('[webFetch] fetching', { url, method, extractMode, maxChars });

  // Check cache (skip for POST — non-idempotent)
  const cacheKey = normalizeCacheKey(`${method ?? 'GET'}:${url}:${extractMode ?? 'text'}:${maxChars}`);
  if (!isPost) {
    const cached = readCache(FETCH_CACHE, cacheKey, CACHE_TTL_MS);
    if (cached) {
      log.trace('[webFetch] cache hit', { url });
      return cached;
    }
  }

  const fetchInit: RequestInit = { signal: withTimeout(30) };
  if (method) fetchInit.method = method;
  if (body) fetchInit.body = body;
  if (headers) fetchInit.headers = headers;
  const response = await fetch(url, fetchInit);

  // ── Binary mode: return base64 data URI ──
  if (extractMode === 'binary') {
    const rawContentType = response.headers.get('content-type') || 'application/octet-stream';
    const mimeType = rawContentType.split(';')[0]!.trim();

    // Pre-check Content-Length to avoid downloading huge files
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > BINARY_MAX_BYTES) {
      return {
        text: '',
        status: response.status,
        mimeType,
        sizeBytes: contentLength,
        isBase64: true,
        error: `Binary content too large: ${contentLength} bytes exceeds ${BINARY_MAX_BYTES} byte limit`,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Post-download size check (Content-Length may be absent or wrong)
    if (bytes.length > BINARY_MAX_BYTES) {
      return {
        text: '',
        status: response.status,
        mimeType,
        sizeBytes: bytes.length,
        isBase64: true,
        error: `Binary content too large: ${bytes.length} bytes exceeds ${BINARY_MAX_BYTES} byte limit`,
      };
    }

    const base64 = uint8ToBase64(bytes);
    const dataUri = `data:${mimeType};base64,${base64}`;

    // Auto-increase maxChars for binary mode
    const effectiveMaxChars = Math.max(maxChars, BINARY_DEFAULT_MAX_CHARS);
    if (dataUri.length > effectiveMaxChars) {
      return {
        text: '',
        status: response.status,
        mimeType,
        sizeBytes: bytes.length,
        isBase64: true,
        error: `Base64 data URI too large: ${dataUri.length} chars exceeds maxChars ${effectiveMaxChars}. Pass a larger maxChars to allow it.`,
      };
    }

    // Skip cache for binary results (large + rarely re-fetched)
    return {
      text: dataUri,
      status: response.status,
      mimeType,
      sizeBytes: bytes.length,
      isBase64: true,
    };
  }

  // ── Text / HTML modes (unchanged) ──
  const html = await response.text();

  // Extract title from <title> tag
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1]?.trim() ? decodeEntities(titleMatch[1].trim()) : undefined;

  let text: string;
  if (extractMode === 'html') {
    text = html.slice(0, maxChars);
  } else {
    text = extractText(html, maxChars);
  }

  const result: WebFetchResult = { text, title, status: response.status };

  // Cache successful text results (skip for POST — non-idempotent)
  if (!isPost && response.ok && text.length > 0) {
    writeCache(FETCH_CACHE, cacheKey, result);
  }

  return result;
};

export { webFetchSchema, executeWebFetch, FETCH_CACHE, extractText, decodeEntities };
export type { WebFetchArgs, WebFetchResult };

// ── Tool registration ──
import type { ToolRegistration, ToolResult } from './tool-registration';

const webFetchToolDef: ToolRegistration = {
  name: 'web_fetch',
  label: 'Fetch URL',
  description:
    'Fetch content from a URL. Supports GET (default) and POST methods with custom headers and body. Extraction modes: "text" strips HTML (default), "html" returns raw, "binary" returns base64 data URI for images/files. For POST requests, set method: "POST" with body and headers.',
  schema: webFetchSchema,
  execute: args => executeWebFetch(args as WebFetchArgs),
  formatResult: (raw): ToolResult => {
    const result = raw as WebFetchResult;
    if (result.isBase64 && result.text) {
      const mediaType = result.mimeType || 'application/octet-stream';
      // Only send as image content block when it's actually an image
      if (mediaType.startsWith('image/')) {
        const rawBase64 = result.text.replace(/^data:[^;]+;base64,/, '');
        return {
          content: [
            {
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: mediaType, data: rawBase64 },
            },
          ],
          details: { mimeType: result.mimeType, sizeBytes: result.sizeBytes },
        };
      }
      // Non-image binary: return metadata (data URI is too large for text block)
      return {
        content: [{ type: 'text', text: `Binary content fetched: ${mediaType}, ${result.sizeBytes ?? 0} bytes` }],
        details: { mimeType: result.mimeType, sizeBytes: result.sizeBytes, dataUri: result.text },
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
  },
};

export { webFetchToolDef };
