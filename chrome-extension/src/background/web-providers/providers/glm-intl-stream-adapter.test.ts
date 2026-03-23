/**
 * Tests for glm-intl-stream-adapter.ts — GLM International SSE stream processing.
 */
import { describe, it, expect } from 'vitest';
import { createGlmIntlStreamAdapter } from './glm-intl-stream-adapter';

/** Helper to build a GLM-Intl SSE parsed object with answer delta. */
const answerEvent = (delta: string) => ({
  type: 'chat:completion',
  data: { delta_content: delta, phase: 'answer' },
});

/** Helper to build a GLM-Intl SSE parsed object with thinking delta. */
const thinkEvent = (delta: string) => ({
  type: 'chat:completion',
  data: { delta_content: delta, phase: 'thinking' },
});

describe('createGlmIntlStreamAdapter', () => {
  describe('basic delta passthrough', () => {
    it('passes answer delta through', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(adapter.processEvent({ parsed: answerEvent('Hello'), delta: null })).toEqual({
        feedText: 'Hello',
      });
    });

    it('returns null for non-chat:completion events', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(
        adapter.processEvent({
          parsed: { type: 'other', data: { delta_content: 'ignored' } },
          delta: null,
        }),
      ).toBeNull();
    });

    it('returns null for events without delta_content', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(
        adapter.processEvent({
          parsed: { type: 'chat:completion', data: { phase: 'other', usage: {} } },
          delta: null,
        }),
      ).toBeNull();
    });
  });

  describe('think content handling', () => {
    it('wraps first thinking delta in <think> tag', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(adapter.processEvent({ parsed: thinkEvent('Let me'), delta: null })).toEqual({
        feedText: '<think>Let me',
      });
    });

    it('passes subsequent thinking deltas through without tag', () => {
      const adapter = createGlmIntlStreamAdapter();
      adapter.processEvent({ parsed: thinkEvent('Let me'), delta: null });
      expect(adapter.processEvent({ parsed: thinkEvent(' think'), delta: null })).toEqual({
        feedText: ' think',
      });
    });

    it('closes think block when transitioning to answer', () => {
      const adapter = createGlmIntlStreamAdapter();
      adapter.processEvent({ parsed: thinkEvent('reasoning'), delta: null });
      const result = adapter.processEvent({ parsed: answerEvent('answer'), delta: null });
      expect(result).toEqual({ feedText: '</think>answer' });
    });

    it('closes think block on flush', () => {
      const adapter = createGlmIntlStreamAdapter();
      adapter.processEvent({ parsed: thinkEvent('incomplete'), delta: null });
      expect(adapter.flush()).toEqual({ feedText: '</think>' });
    });

    it('flush returns null when no think was started', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(adapter.flush()).toBeNull();
    });
  });

  describe('non-standard closing tag normalization', () => {
    it('normalizes </tool_call的工具结果> to </tool_call>', () => {
      const adapter = createGlmIntlStreamAdapter();
      const result = adapter.processEvent({
        parsed: answerEvent('{"query":"test"}</tool_call的工具结果>'),
        delta: null,
      });
      expect(result!.feedText).toContain('</tool_call>');
      expect(result!.feedText).not.toContain('的工具结果');
    });

    it('normalizes </tool_call〉 (fullwidth bracket) to </tool_call>', () => {
      const adapter = createGlmIntlStreamAdapter();
      const result = adapter.processEvent({
        parsed: answerEvent('{"query":"test"}\n</tool_call〉'),
        delta: null,
      });
      expect(result!.feedText).toContain('</tool_call>');
      expect(result!.feedText).not.toContain('〉');
    });

    it('normalizes </tool_call＞ (fullwidth greater-than U+FF1E) to </tool_call>', () => {
      const adapter = createGlmIntlStreamAdapter();
      const result = adapter.processEvent({
        parsed: answerEvent('{"query":"test"}\n</tool_call\uFF1E'),
        delta: null,
      });
      expect(result!.feedText).toContain('</tool_call>');
      expect(result!.feedText).not.toContain('\uFF1E');
    });

    it("normalizes </call'> (truncated tag name) to </tool_call>", () => {
      const adapter = createGlmIntlStreamAdapter();
      const result = adapter.processEvent({
        parsed: answerEvent('{"url": "https://example.com"}</call\'>'),
        delta: null,
      });
      expect(result!.feedText).toContain('</tool_call>');
      expect(result!.feedText).not.toContain("</call'>");
    });

    it('preserves standard </tool_call> as-is', () => {
      const adapter = createGlmIntlStreamAdapter();
      const result = adapter.processEvent({
        parsed: answerEvent('{"query":"test"}</tool_call>'),
        delta: null,
      });
      expect(result!.feedText).toContain('</tool_call>');
    });
  });

  describe('edge cases', () => {
    it('shouldAbort always returns false', () => {
      const adapter = createGlmIntlStreamAdapter();
      expect(adapter.shouldAbort()).toBe(false);
    });
  });
});
