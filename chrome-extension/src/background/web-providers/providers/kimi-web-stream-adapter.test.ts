/**
 * Tests for kimi-stream-adapter.ts — Kimi-specific SSE stream processing.
 */
import { describe, it, expect } from 'vitest';
import { createKimiStreamAdapter } from './kimi-web-stream-adapter';

describe('createKimiStreamAdapter', () => {
  describe('processEvent', () => {
    it('passes through regular text delta', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.processEvent({
        parsed: { op: 'append', block: { text: { content: 'hello' } } },
        delta: 'hello',
      });
      expect(result).toEqual({ feedText: 'hello' });
    });

    it('returns null when delta is null', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.processEvent({
        parsed: { op: 'set', block: { type: 'image' } },
        delta: null,
      });
      expect(result).toBeNull();
    });

    it('returns final delta on done frame', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.processEvent({
        parsed: { done: true },
        delta: 'last bit',
      });
      expect(result).toEqual({ feedText: 'last bit' });
    });

    it('returns null on done frame with no delta', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.processEvent({
        parsed: { done: true },
        delta: null,
      });
      expect(result).toBeNull();
    });

    it('throws on error frame', () => {
      const adapter = createKimiStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
          delta: null,
        }),
      ).toThrow('Too many requests');
    });

    it('throws with code when error has no message', () => {
      const adapter = createKimiStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: { error: { code: 'INTERNAL_ERROR' } },
          delta: null,
        }),
      ).toThrow('INTERNAL_ERROR');
    });

    it('throws generic message when error has neither code nor message', () => {
      const adapter = createKimiStreamAdapter();
      expect(() =>
        adapter.processEvent({
          parsed: { error: {} },
          delta: null,
        }),
      ).toThrow('Unknown Kimi error');
    });
  });

  describe('flush', () => {
    it('returns null', () => {
      const adapter = createKimiStreamAdapter();
      expect(adapter.flush()).toBeNull();
    });
  });

  describe('shouldAbort', () => {
    it('always returns false', () => {
      const adapter = createKimiStreamAdapter();
      expect(adapter.shouldAbort()).toBe(false);

      // Even after processing events
      adapter.processEvent({ parsed: { op: 'append' }, delta: 'text' });
      expect(adapter.shouldAbort()).toBe(false);
    });
  });

  describe('processEvent — block.exception', () => {
    it('captures REASON_COMPLETION_OVERLOADED from block.exception', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.processEvent({
        parsed: {
          op: 'set',
          mask: 'block.exception',
          block: {
            id: '1',
            exception: {
              error: {
                reason: 'REASON_COMPLETION_OVERLOADED',
                localizedMessage: {
                  locale: 'zh-CN',
                  message: '不好意思，刚刚和Kimi聊的人太多了。',
                },
                severity: 'SEVERITY_BLOCK_RETRACT',
              },
            },
          },
        },
        delta: null,
      });
      // processEvent returns null (no text to feed), but stores the error
      expect(result).toBeNull();

      // onFinish surfaces the captured error
      const finish = adapter.onFinish!({ hasToolCalls: false, fullText: '', thinkingContent: undefined });
      expect(finish).toEqual({ error: '不好意思，刚刚和Kimi聊的人太多了。' });
    });

    it('falls back to reason when no localizedMessage', () => {
      const adapter = createKimiStreamAdapter();
      adapter.processEvent({
        parsed: {
          op: 'set',
          mask: 'block.exception',
          block: {
            id: '1',
            exception: {
              error: {
                reason: 'REASON_UNKNOWN',
              },
            },
          },
        },
        delta: null,
      });
      const finish = adapter.onFinish!({ hasToolCalls: false, fullText: '', thinkingContent: undefined });
      expect(finish).toEqual({ error: 'REASON_UNKNOWN' });
    });
  });

  describe('onFinish', () => {
    it('returns error on completely empty response', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.onFinish!({ hasToolCalls: false, fullText: '', thinkingContent: undefined });
      expect(result).toEqual({ error: 'Kimi returned an empty response' });
    });

    it('returns null when text is present', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.onFinish!({ hasToolCalls: false, fullText: 'Some response', thinkingContent: undefined });
      expect(result).toBeNull();
    });

    it('returns null when tool calls are present', () => {
      const adapter = createKimiStreamAdapter();
      const result = adapter.onFinish!({ hasToolCalls: true, fullText: '', thinkingContent: undefined });
      expect(result).toBeNull();
    });

    it('prioritizes server error over empty response', () => {
      const adapter = createKimiStreamAdapter();
      // Capture a server error first
      adapter.processEvent({
        parsed: {
          op: 'set',
          mask: 'block.exception',
          block: { id: '1', exception: { error: { reason: 'REASON_COMPLETION_OVERLOADED', localizedMessage: { message: 'Kimi is overloaded' } } } },
        },
        delta: null,
      });
      // Even with some text, server error takes priority
      const result = adapter.onFinish!({ hasToolCalls: false, fullText: '', thinkingContent: undefined });
      expect(result).toEqual({ error: 'Kimi is overloaded' });
    });
  });
});
