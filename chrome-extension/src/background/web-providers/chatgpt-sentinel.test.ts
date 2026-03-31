/**
 * Tests for ChatGPT Sentinel antibot challenge resolution logic.
 *
 * The sentinel code lives inside content-fetch-main.ts (MAIN world), but the
 * proof-token resolution pattern is non-trivial and warrants explicit coverage:
 * - bm may be an enforcer with getEnforcementToken() (older API)
 * - bm may be a PoW solver object {answers, maxAttempts, requirementsSeed, sid}
 *   which should be passed directly to fX() for header building
 * - bm may be undefined/null
 *
 * Additionally, the auto-discovery system classifies module exports by structural
 * signature (arity, shape) to survive minified name rotations.
 */
import { describe, it, expect, vi } from 'vitest';

// ── Helpers ─────────────────────────────────────

/**
 * Resolve proof token from the sentinel module's powEnforcer export.
 * Mirrors the logic in content-fetch-main.ts resolveSentinelHeaders().
 */
const resolveProofToken = async (
  bm: unknown,
  chatReqs: Record<string, unknown>,
): Promise<unknown> => {
  if (!bm || typeof bm !== 'object') return null;

  const bmObj = bm as Record<string, unknown>;

  // Pattern 1: enforcer with getEnforcementToken()
  if (typeof bmObj.getEnforcementToken === 'function') {
    return Promise.race([
      (bmObj.getEnforcementToken as (reqs: unknown) => Promise<unknown>)(chatReqs),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Proof token timed out after 15s')), 15_000),
      ),
    ]);
  }

  // Pattern 2: PoW solver object — pass directly to headerBuilder
  if (bmObj.answers !== undefined) {
    return bm;
  }

  return null;
};

// ── Auto-discovery types ──

interface SentinelExports {
  chatRequirements: () => Promise<Record<string, unknown>>;
  turnstileSolver?: (key: unknown) => Promise<unknown>;
  arkoseEnforcer?: { getEnforcementToken: (reqs: unknown) => Promise<unknown> };
  powEnforcer?: unknown;
  headerBuilder: (...args: unknown[]) => Promise<Record<string, string>>;
}

const KNOWN_NAMES = { chatRequirements: 'bk', turnstileSolver: 'bi', arkoseEnforcer: 'bl', powEnforcer: 'bm', headerBuilder: 'fX' };

/**
 * Discover sentinel function roles from module exports.
 * Mirrors the logic in content-fetch-main.ts discoverSentinelExports().
 *
 * Phase 1: fn.toString() body fingerprinting — matches stable string literals
 * Phase 2: Arity fallback — if body fingerprinting missed something
 */
const discoverSentinelExports = (mod: Record<string, unknown>, diag: string[]): SentinelExports | null => {
  // Fast path — check known minified names first
  if (typeof mod[KNOWN_NAMES.chatRequirements] === 'function' && typeof mod[KNOWN_NAMES.headerBuilder] === 'function') {
    diag.push('discovery=known-names');
    return {
      chatRequirements: mod[KNOWN_NAMES.chatRequirements] as SentinelExports['chatRequirements'],
      turnstileSolver: typeof mod[KNOWN_NAMES.turnstileSolver] === 'function'
        ? mod[KNOWN_NAMES.turnstileSolver] as SentinelExports['turnstileSolver']
        : undefined,
      arkoseEnforcer: mod[KNOWN_NAMES.arkoseEnforcer] && typeof (mod[KNOWN_NAMES.arkoseEnforcer] as Record<string, unknown>).getEnforcementToken === 'function'
        ? mod[KNOWN_NAMES.arkoseEnforcer] as SentinelExports['arkoseEnforcer']
        : undefined,
      powEnforcer: mod[KNOWN_NAMES.powEnforcer] ?? undefined,
      headerBuilder: mod[KNOWN_NAMES.headerBuilder] as SentinelExports['headerBuilder'],
    };
  }

  // Fallback — scan all exports by function body content + structural shape
  diag.push('discovery=fingerprint');
  const exportKeys = Object.keys(mod);
  diag.push(`exports=[${exportKeys.join(',')}]`);

  let chatRequirements: SentinelExports['chatRequirements'] | undefined;
  let headerBuilder: SentinelExports['headerBuilder'] | undefined;
  let turnstileSolver: SentinelExports['turnstileSolver'] | undefined;
  let arkoseEnforcer: SentinelExports['arkoseEnforcer'] | undefined;
  let powEnforcer: unknown;

  // Phase 1: Body fingerprinting
  for (const key of exportKeys) {
    const val = mod[key];
    if (typeof val === 'function') {
      const fn = val as (...args: unknown[]) => unknown;
      let body = '';
      try { body = fn.toString(); } catch { /* toString may fail on native code */ }

      if (body && !body.startsWith('[')) {
        if (!chatRequirements && body.includes('chat-requirements') && !body.includes('requirements-token')) {
          chatRequirements = fn as SentinelExports['chatRequirements'];
          diag.push(`chatRequirements=${key}(body-match)`);
        }
        else if (!headerBuilder && (body.includes('requirements-token') || body.includes('openai-sentinel'))) {
          headerBuilder = fn as SentinelExports['headerBuilder'];
          diag.push(`headerBuilder=${key}(body-match)`);
        }
        else if (!turnstileSolver && fn.length <= 2 && /turnstile/i.test(body)) {
          turnstileSolver = fn as SentinelExports['turnstileSolver'];
          diag.push(`turnstileSolver=${key}(body-match)`);
        }
      }
    } else if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      if (typeof obj.getEnforcementToken === 'function') {
        if ((obj as Record<string, unknown>).answers === undefined && !arkoseEnforcer) {
          arkoseEnforcer = obj as SentinelExports['arkoseEnforcer'];
          diag.push(`arkoseEnforcer=${key}(hasGetEnforcementToken)`);
        } else if (!powEnforcer) {
          powEnforcer = obj;
          diag.push(`powEnforcer=${key}(enforcer)`);
        }
      } else if (obj.answers !== undefined && !powEnforcer) {
        powEnforcer = obj;
        diag.push(`powEnforcer=${key}(hasPowAnswers)`);
      }
    }
  }

  // Phase 2: Arity fallback
  if (!headerBuilder) {
    for (const key of exportKeys) {
      const val = mod[key];
      if (typeof val === 'function' && (val as (...a: unknown[]) => unknown).length === 5) {
        headerBuilder = val as SentinelExports['headerBuilder'];
        diag.push(`headerBuilder=${key}(arity5)`);
        break;
      }
    }
  }
  if (!chatRequirements) {
    const arity0Fns: Array<{ name: string; fn: (...args: unknown[]) => unknown }> = [];
    for (const key of exportKeys) {
      const val = mod[key];
      if (typeof val === 'function' && (val as (...a: unknown[]) => unknown).length === 0
        && val !== headerBuilder && val !== turnstileSolver) {
        arity0Fns.push({ name: key, fn: val as (...a: unknown[]) => unknown });
      }
    }
    if (arity0Fns.length === 1) {
      chatRequirements = arity0Fns[0]!.fn as SentinelExports['chatRequirements'];
      diag.push(`chatRequirements=${arity0Fns[0]!.name}(arity0-unique)`);
    } else if (arity0Fns.length > 1) {
      const candidate = arity0Fns.find(f => f.name !== '__esModule' && f.name !== 'default');
      if (candidate) {
        chatRequirements = candidate.fn as SentinelExports['chatRequirements'];
        diag.push(`chatRequirements=${candidate.name}(arity0-filtered)`);
      }
    }
  }
  if (!turnstileSolver) {
    for (const key of exportKeys) {
      const val = mod[key];
      if (typeof val === 'function' && (val as (...a: unknown[]) => unknown).length === 1 && val !== chatRequirements && val !== headerBuilder) {
        turnstileSolver = val as SentinelExports['turnstileSolver'];
        diag.push(`turnstileSolver=${key}(arity1)`);
        break;
      }
    }
  }

  if (!chatRequirements || !headerBuilder) {
    diag.push(`missing: chatRequirements=${!!chatRequirements}, headerBuilder=${!!headerBuilder}`);
    return null;
  }

  return { chatRequirements, turnstileSolver, arkoseEnforcer, powEnforcer, headerBuilder };
};

/**
 * Simulate the sentinel resolution flow using discovered exports.
 * Returns { headers, error } matching the pattern in content-fetch-main.ts.
 */
const resolveSentinel = async (mod: Record<string, unknown>) => {
  let sentinelHeaders: Record<string, string> = {};
  let sentinelError = '';
  const diag: string[] = [];

  try {
    const exports = discoverSentinelExports(mod, diag);
    if (!exports) {
      const exportNames = Object.keys(mod).join(', ');
      sentinelError = `Sentinel function discovery failed — could not identify chatRequirements/headerBuilder from exports: [${exportNames}]`;
      return { sentinelHeaders, sentinelError, diag };
    }

    const chatReqs = await exports.chatRequirements();
    const turnstile = chatReqs?.turnstile as Record<string, unknown> | undefined;
    const turnstileKey = turnstile?.bx ?? turnstile?.dx;

    if (!turnstileKey) {
      sentinelError = 'Sentinel chat-requirements response missing turnstile key';
      return { sentinelHeaders, sentinelError, diag };
    }

    let turnstileToken: unknown = null;
    try {
      if (exports.turnstileSolver) {
        turnstileToken = await exports.turnstileSolver(turnstileKey);
      }
    } catch {
      /* continue without */
    }

    let arkoseToken: unknown = null;
    try {
      if (exports.arkoseEnforcer?.getEnforcementToken) {
        arkoseToken = await exports.arkoseEnforcer.getEnforcementToken(chatReqs);
      }
    } catch {
      /* continue without */
    }

    let proofToken: unknown = null;
    try {
      proofToken = await resolveProofToken(exports.powEnforcer, chatReqs);
    } catch {
      /* continue without */
    }

    const extraHeaders = await exports.headerBuilder(chatReqs, arkoseToken, turnstileToken, proofToken, null);

    if (typeof extraHeaders === 'object' && extraHeaders !== null) {
      sentinelHeaders = extraHeaders as Record<string, string>;
    }
  } catch (e) {
    sentinelError = `Sentinel challenge failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  return { sentinelHeaders, sentinelError, diag };
};

// ── Tests ────────────────────────────────────────

describe('resolveProofToken', () => {
  it('returns null when bm is undefined', async () => {
    expect(await resolveProofToken(undefined, {})).toBeNull();
  });

  it('returns null when bm is null', async () => {
    expect(await resolveProofToken(null, {})).toBeNull();
  });

  it('returns null when bm is a non-object', async () => {
    expect(await resolveProofToken('string', {})).toBeNull();
    expect(await resolveProofToken(42, {})).toBeNull();
  });

  it('returns null when bm has no known interface', async () => {
    expect(await resolveProofToken({ foo: 'bar' }, {})).toBeNull();
  });

  it('calls getEnforcementToken when available (enforcer pattern)', async () => {
    const mockEnforcer = {
      getEnforcementToken: vi.fn(async () => 'proof-token-value'),
    };
    const chatReqs = { proofofwork: { required: true, seed: '0.123', difficulty: '06340b' } };

    const result = await resolveProofToken(mockEnforcer, chatReqs);

    expect(result).toBe('proof-token-value');
    expect(mockEnforcer.getEnforcementToken).toHaveBeenCalledWith(chatReqs);
  });

  it('returns bm directly when it has answers (PoW solver pattern)', async () => {
    const powSolver = {
      answers: {},
      maxAttempts: 100,
      requirementsSeed: '0.123',
      sid: 'session-id',
    };

    const result = await resolveProofToken(powSolver, {});

    expect(result).toBe(powSolver);
  });

  it('prefers getEnforcementToken over answers when both exist', async () => {
    const hybrid = {
      getEnforcementToken: vi.fn(async () => 'enforcer-result'),
      answers: {},
    };

    const result = await resolveProofToken(hybrid, {});

    expect(result).toBe('enforcer-result');
    expect(hybrid.getEnforcementToken).toHaveBeenCalled();
  });

  it('returns bm with empty answers object', async () => {
    const powSolver = { answers: {} };
    const result = await resolveProofToken(powSolver, {});
    expect(result).toBe(powSolver);
  });

  it('returns bm with populated answers', async () => {
    const powSolver = { answers: { 'hash-1': 42 } };
    const result = await resolveProofToken(powSolver, {});
    expect(result).toBe(powSolver);
  });
});

// ── Auto-discovery Tests ────────────────────────

describe('discoverSentinelExports', () => {
  describe('fast path (known names)', () => {
    it('discovers exports using known names bk/bi/bl/bm/fX', () => {
      const mod = {
        bk: vi.fn(async () => ({})),
        bi: vi.fn(async () => 'token'),
        bl: { getEnforcementToken: vi.fn(async () => 'arkose') },
        bm: { answers: {}, maxAttempts: 100 },
        fX: vi.fn(async () => ({})),
      };
      const diag: string[] = [];
      const result = discoverSentinelExports(mod as Record<string, unknown>, diag);

      expect(result).not.toBeNull();
      expect(result!.chatRequirements).toBe(mod.bk);
      expect(result!.turnstileSolver).toBe(mod.bi);
      expect(result!.arkoseEnforcer).toBe(mod.bl);
      expect(result!.powEnforcer).toBe(mod.bm);
      expect(result!.headerBuilder).toBe(mod.fX);
      expect(diag).toContain('discovery=known-names');
    });

    it('works with only bk and fX (minimal known names)', () => {
      const mod = {
        bk: vi.fn(async () => ({})),
        fX: vi.fn(async () => ({})),
      };
      const diag: string[] = [];
      const result = discoverSentinelExports(mod as Record<string, unknown>, diag);

      expect(result).not.toBeNull();
      expect(result!.chatRequirements).toBe(mod.bk);
      expect(result!.headerBuilder).toBe(mod.fX);
      expect(result!.turnstileSolver).toBeUndefined();
      expect(result!.arkoseEnforcer).toBeUndefined();
      expect(result!.powEnforcer).toBeUndefined();
    });
  });

  describe('body fingerprint fallback (rotated names)', () => {
    /** Helper: create a function whose toString() returns a specific body */
    const fnWithBody = (body: string, arity = 0): ((...args: unknown[]) => unknown) => {
      // Create function with desired arity, then override toString
      const fn = arity === 0
        ? vi.fn(async () => ({}))
        : arity === 1
          ? vi.fn(async (_a: unknown) => ({}))
          : vi.fn(async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown) => ({}));
      fn.toString = () => body;
      return fn as unknown as (...args: unknown[]) => unknown;
    };

    it('discovers chatRequirements by body containing "chat-requirements"', () => {
      const chatReqsFn = fnWithBody('async function cQ(){return fetch("/sentinel/chat-requirements",{method:"POST"})}');
      const headerFn = fnWithBody('function hB(a,b,c){return{"openai-sentinel-chat-requirements-token":a}}', 5);

      const mod: Record<string, unknown> = {
        cQ: chatReqsFn,
        hB: headerFn,
      };
      const diag: string[] = [];
      const result = discoverSentinelExports(mod, diag);

      expect(result).not.toBeNull();
      expect(result!.chatRequirements).toBe(chatReqsFn);
      expect(result!.headerBuilder).toBe(headerFn);
      expect(diag.some(d => d.includes('chatRequirements=cQ(body-match)'))).toBe(true);
      expect(diag.some(d => d.includes('headerBuilder=hB(body-match)'))).toBe(true);
    });

    it('discovers headerBuilder by body containing "requirements-token"', () => {
      const headerFn = fnWithBody('function x(r,a,t,p,n){return{"openai-sentinel-chat-requirements-token":r}}', 5);
      const chatReqsFn = fnWithBody('async function y(){return fetch("chat-requirements")}');

      const mod: Record<string, unknown> = { x: headerFn, y: chatReqsFn };
      const diag: string[] = [];
      const result = discoverSentinelExports(mod, diag);

      expect(result).not.toBeNull();
      expect(result!.headerBuilder).toBe(headerFn);
      expect(diag.some(d => d.includes('headerBuilder=x(body-match)'))).toBe(true);
    });

    it('discovers turnstileSolver by body containing "turnstile"', () => {
      const chatReqsFn = fnWithBody('async function a(){return fetch("chat-requirements")}');
      const headerFn = fnWithBody('function b(){return{"requirements-token":"x"}}');
      const turnstileFn = fnWithBody('async function c(k){return window.turnstile.render(k)}', 1);

      const mod: Record<string, unknown> = { a: chatReqsFn, b: headerFn, c: turnstileFn };
      const diag: string[] = [];
      const result = discoverSentinelExports(mod, diag);

      expect(result).not.toBeNull();
      expect(result!.turnstileSolver).toBe(turnstileFn);
      expect(diag.some(d => d.includes('turnstileSolver=c(body-match)'))).toBe(true);
    });

    it('does NOT match chatRequirements when body also contains "requirements-token"', () => {
      // A function that references both should be classified as headerBuilder, not chatRequirements
      const ambiguousFn = fnWithBody('function z(){return{"chat-requirements":"x","requirements-token":"y"}}');
      const realChatReqs = fnWithBody('async function q(){return fetch("chat-requirements")}');

      const mod: Record<string, unknown> = { z: ambiguousFn, q: realChatReqs };
      const diag: string[] = [];
      const result = discoverSentinelExports(mod, diag);

      expect(result).not.toBeNull();
      expect(result!.headerBuilder).toBe(ambiguousFn); // classified as headerBuilder
      expect(result!.chatRequirements).toBe(realChatReqs);
    });

    it('resists false positives: unrelated functions with matching arity are NOT selected over body matches', () => {
      // Simulate 200+ exports where many have matching arity but wrong body
      const unrelatedArity0 = fnWithBody('function $(){return Math.random()}');
      const unrelatedArity1 = fnWithBody('function _(x){return x+1}', 1);
      const unrelatedArity5 = fnWithBody('function z(a,b,c,d,e){return a}', 5);
      const realChatReqs = fnWithBody('async function cQ(){return fetch("/sentinel/chat-requirements")}');
      const realHeaderBuilder = fnWithBody('function hB(r){return{"openai-sentinel-chat-requirements-token":r}}');
      const realTurnstile = fnWithBody('async function tS(k){return turnstile.render(k)}', 1);

      const mod: Record<string, unknown> = {
        $: unrelatedArity0,
        _: unrelatedArity1,
        z: unrelatedArity5,
        cQ: realChatReqs,
        hB: realHeaderBuilder,
        tS: realTurnstile,
      };
      const diag: string[] = [];
      const result = discoverSentinelExports(mod, diag);

      expect(result).not.toBeNull();
      expect(result!.chatRequirements).toBe(realChatReqs);
      expect(result!.headerBuilder).toBe(realHeaderBuilder);
      expect(result!.turnstileSolver).toBe(realTurnstile);
      // Should NOT have picked up unrelated functions
      expect(result!.chatRequirements).not.toBe(unrelatedArity0);
      expect(result!.headerBuilder).not.toBe(unrelatedArity5);
      expect(result!.turnstileSolver).not.toBe(unrelatedArity1);
    });

    it('falls back to arity when fn.toString() has no keywords', () => {
      // Functions with no identifiable body keywords but correct arity
      const chatReqsFn = Object.defineProperty(
        vi.fn(async () => ({ turnstile: { dx: 'key' }, proofofwork: {} })),
        'length', { value: 0 },
      );
      const headerFn = Object.defineProperty(
        vi.fn(async () => ({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'ok' })),
        'length', { value: 5 },
      );

      const mod: Record<string, unknown> = {
        aX: chatReqsFn,
        eV: headerFn,
      };
      const diag: string[] = [];
      const result = discoverSentinelExports(mod, diag);

      expect(result).not.toBeNull();
      expect(result!.chatRequirements).toBe(chatReqsFn);
      expect(result!.headerBuilder).toBe(headerFn);
      // Should have used arity fallback
      expect(diag.some(d => d.includes('arity5'))).toBe(true);
      expect(diag.some(d => d.includes('arity0'))).toBe(true);
    });

    it('uses body match for some + arity fallback for others (mixed)', () => {
      const chatReqsFn = fnWithBody('async function cQ(){return fetch("/sentinel/chat-requirements")}');
      // headerBuilder has no identifiable body keywords — falls back to arity
      const headerFn = Object.defineProperty(
        vi.fn(async () => ({})),
        'length', { value: 5 },
      );

      const mod: Record<string, unknown> = { cQ: chatReqsFn, hB: headerFn };
      const diag: string[] = [];
      const result = discoverSentinelExports(mod, diag);

      expect(result).not.toBeNull();
      expect(result!.chatRequirements).toBe(chatReqsFn);
      expect(result!.headerBuilder).toBe(headerFn);
      expect(diag.some(d => d.includes('chatRequirements=cQ(body-match)'))).toBe(true);
      expect(diag.some(d => d.includes('headerBuilder=hB(arity5)'))).toBe(true);
    });

    it('discovers chatRequirements from multiple arity-0 fns by filtering __esModule (arity fallback)', () => {
      const chatReqsFn = Object.defineProperty(
        vi.fn(async () => ({ turnstile: { dx: 'key' } })),
        'length', { value: 0 },
      );
      const esModuleFn = Object.defineProperty(
        vi.fn(() => true),
        'length', { value: 0 },
      );
      const headerFn = fnWithBody('function hB(){return{"requirements-token":"x"}}');

      const mod: Record<string, unknown> = {
        __esModule: esModuleFn,
        xK: chatReqsFn,
        yL: headerFn,
      };
      const diag: string[] = [];
      const result = discoverSentinelExports(mod, diag);

      expect(result).not.toBeNull();
      expect(result!.chatRequirements).toBe(chatReqsFn);
      expect(diag.some(d => d.includes('arity0-filtered'))).toBe(true);
    });

    it('distinguishes arkose and PoW enforcers (both have getEnforcementToken)', () => {
      const chatReqsFn = fnWithBody('async function a(){return fetch("chat-requirements")}');
      const headerFn = fnWithBody('function b(){return{"requirements-token":"x"}}');

      const mod: Record<string, unknown> = {
        a1: chatReqsFn,
        a2: headerFn,
        a3: { getEnforcementToken: vi.fn() },  // arkose (no .answers)
        a4: { getEnforcementToken: vi.fn(), answers: {} },  // PoW (has .answers)
      };
      const diag: string[] = [];
      const result = discoverSentinelExports(mod, diag);

      expect(result).not.toBeNull();
      expect(result!.arkoseEnforcer).toBe(mod.a3);
      expect(result!.powEnforcer).toBe(mod.a4);
    });

    it('skips fn.toString() that returns [native code]', () => {
      const nativeFn = vi.fn(async () => ({}));
      nativeFn.toString = () => '[native code]';
      // Should fall through to arity fallback
      const headerFn = fnWithBody('function h(){return{"requirements-token":"x"}}');

      const mod: Record<string, unknown> = {
        native: nativeFn as unknown,
        h: headerFn,
      };
      const diag: string[] = [];
      discoverSentinelExports(mod, diag);

      // native should NOT have been matched by body fingerprinting
      expect(diag.some(d => d.includes('native(body-match)'))).toBe(false);
    });
  });

  describe('failure cases', () => {
    it('returns null when no headerBuilder is found (no body match, no arity match)', () => {
      const chatReqsFn = vi.fn(async () => ({}));
      chatReqsFn.toString = () => 'function q(){return fetch("chat-requirements")}';
      const mod: Record<string, unknown> = { a1: chatReqsFn };
      const diag: string[] = [];

      expect(discoverSentinelExports(mod, diag)).toBeNull();
      expect(diag.some(d => d.includes('headerBuilder=false'))).toBe(true);
    });

    it('returns null when no chatRequirements is found (no body match, no arity match)', () => {
      const headerFn = vi.fn(async () => ({}));
      headerFn.toString = () => 'function h(){return{"requirements-token":"x"}}';
      const mod: Record<string, unknown> = { a1: headerFn };
      const diag: string[] = [];

      expect(discoverSentinelExports(mod, diag)).toBeNull();
      expect(diag.some(d => d.includes('chatRequirements=false'))).toBe(true);
    });

    it('returns null for empty module', () => {
      const diag: string[] = [];
      expect(discoverSentinelExports({}, diag)).toBeNull();
    });

    it('includes export names in diag when fingerprinting', () => {
      const headerFn = vi.fn(async () => ({}));
      headerFn.toString = () => 'function h(){return{"requirements-token":"x"}}';
      const mod: Record<string, unknown> = { foo: headerFn, bar: 'string', baz: 42 };
      const diag: string[] = [];

      discoverSentinelExports(mod, diag);

      expect(diag.some(d => d.includes('exports=[foo,bar,baz]'))).toBe(true);
    });
  });
});

// ── End-to-end Sentinel Resolution Tests ────────

describe('resolveSentinel', () => {
  const mockChatReqs = {
    persona: 'default',
    token: 'req-token',
    turnstile: { required: true, dx: 'turnstile-key-abc' },
    proofofwork: { required: true, seed: '0.123', difficulty: '06340b' },
  };

  it('returns error when discovery fails (no known or fingerprinted exports)', async () => {
    const mod = { randomExport: 'not-a-function' };
    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod);
    expect(sentinelError).toContain('discovery failed');
    expect(Object.keys(sentinelHeaders)).toHaveLength(0);
  });

  it('returns error when bk is missing (known-names fast path fails)', async () => {
    const mod = { fX: vi.fn() };
    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod as Record<string, unknown>);
    expect(sentinelError).toContain('discovery failed');
    expect(Object.keys(sentinelHeaders)).toHaveLength(0);
  });

  it('returns error when turnstile key is missing', async () => {
    const mod = {
      bk: vi.fn(async () => ({ turnstile: {} })),
      fX: vi.fn(),
    };
    const { sentinelError } = await resolveSentinel(mod as Record<string, unknown>);
    expect(sentinelError).toContain('missing turnstile key');
  });

  it('produces headers with all tokens via known names (enforcer bm)', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      bl: { getEnforcementToken: vi.fn(async () => 'arkose-token') },
      bm: { getEnforcementToken: vi.fn(async () => 'proof-token') },
      fX: vi.fn(async (reqs: unknown, arkose: unknown, turnstile: unknown, proof: unknown) => ({
        'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header',
        'OpenAI-Sentinel-Turnstile-Token': turnstile,
        'OpenAI-Sentinel-Proof-Token': proof,
      })),
    };

    const { sentinelHeaders, sentinelError, diag } = await resolveSentinel(mod as Record<string, unknown>);

    expect(sentinelError).toBe('');
    expect(sentinelHeaders['OpenAI-Sentinel-Chat-Requirements-Token']).toBe('req-header');
    expect(sentinelHeaders['OpenAI-Sentinel-Turnstile-Token']).toBe('turnstile-token');
    expect(sentinelHeaders['OpenAI-Sentinel-Proof-Token']).toBe('proof-token');
    expect(mod.bm.getEnforcementToken).toHaveBeenCalledWith(mockChatReqs);
    expect(diag).toContain('discovery=known-names');
  });

  it('produces headers with rotated names via body fingerprint discovery', async () => {
    const chatReqsFn = vi.fn(async () => mockChatReqs);
    chatReqsFn.toString = () => 'async function cQ(){return fetch("/sentinel/chat-requirements")}';
    const turnstileFn = vi.fn(async () => 'turnstile-token');
    turnstileFn.toString = () => 'async function tS(k){return window.turnstile.render(k)}';
    Object.defineProperty(turnstileFn, 'length', { value: 1 });
    const headerFn = vi.fn(async (_reqs: unknown, _arkose: unknown, turnstile: unknown, _proof: unknown) => ({
      'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header',
      'OpenAI-Sentinel-Turnstile-Token': turnstile,
    }));
    headerFn.toString = () => 'function hB(r,a,t,p,n){return{"openai-sentinel-chat-requirements-token":r}}';

    const mod: Record<string, unknown> = {
      xA: chatReqsFn,
      xB: turnstileFn,
      xC: headerFn,
    };

    const { sentinelHeaders, sentinelError, diag } = await resolveSentinel(mod);

    expect(sentinelError).toBe('');
    expect(sentinelHeaders['OpenAI-Sentinel-Chat-Requirements-Token']).toBe('req-header');
    expect(sentinelHeaders['OpenAI-Sentinel-Turnstile-Token']).toBe('turnstile-token');
    expect(diag).toContain('discovery=fingerprint');
    expect(diag.some(d => d.includes('body-match'))).toBe(true);
  });

  it('produces headers with PoW solver bm (answers pattern)', async () => {
    const powSolver = { answers: {}, maxAttempts: 100, requirementsSeed: '0.5', sid: 'sid-1' };
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      bm: powSolver,
      fX: vi.fn(async (_reqs: unknown, _arkose: unknown, _turnstile: unknown, proof: unknown) => ({
        'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header',
        'OpenAI-Sentinel-Turnstile-Token': 'turnstile-token',
        'OpenAI-Sentinel-Proof-Token': 'pow-proof-header',
      })),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod as Record<string, unknown>);

    expect(sentinelError).toBe('');
    expect(sentinelHeaders['OpenAI-Sentinel-Proof-Token']).toBe('pow-proof-header');
    // headerBuilder receives the PoW solver object directly
    expect(mod.fX).toHaveBeenCalledWith(
      mockChatReqs,
      null, // arkose (bl not present)
      'turnstile-token',
      powSolver, // proof = bm object itself
      null,
    );
  });

  it('produces headers without proof when bm is absent', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      fX: vi.fn(async () => ({
        'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header',
        'OpenAI-Sentinel-Turnstile-Token': 'turnstile-token',
      })),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod as Record<string, unknown>);

    expect(sentinelError).toBe('');
    expect(sentinelHeaders['OpenAI-Sentinel-Proof-Token']).toBeUndefined();
    expect(mod.fX).toHaveBeenCalledWith(mockChatReqs, null, 'turnstile-token', null, null);
  });

  it('continues when turnstile solver fails', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => {
        throw new Error('Turnstile failed');
      }),
      fX: vi.fn(async () => ({
        'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header',
      })),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod as Record<string, unknown>);

    expect(sentinelError).toBe('');
    expect(sentinelHeaders['OpenAI-Sentinel-Chat-Requirements-Token']).toBe('req-header');
    // headerBuilder called with null turnstile token
    expect(mod.fX).toHaveBeenCalledWith(mockChatReqs, null, null, null, null);
  });

  it('continues when arkose solver fails', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      bl: {
        getEnforcementToken: vi.fn(async () => {
          throw new Error('Arkose captcha');
        }),
      },
      fX: vi.fn(async () => ({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header' })),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod as Record<string, unknown>);

    expect(sentinelError).toBe('');
    expect(mod.fX).toHaveBeenCalledWith(mockChatReqs, null, 'turnstile-token', null, null);
  });

  it('continues when proof solver fails', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      bm: {
        getEnforcementToken: vi.fn(async () => {
          throw new Error('PoW failed');
        }),
      },
      fX: vi.fn(async () => ({ 'OpenAI-Sentinel-Chat-Requirements-Token': 'req-header' })),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod as Record<string, unknown>);

    expect(sentinelError).toBe('');
    expect(mod.fX).toHaveBeenCalledWith(mockChatReqs, null, 'turnstile-token', null, null);
  });

  it('uses turnstile.bx when dx is absent', async () => {
    const chatReqs = {
      turnstile: { required: true, bx: 'bx-key-123' },
      proofofwork: { required: false },
    };
    const mod = {
      bk: vi.fn(async () => chatReqs),
      bi: vi.fn(async (key: unknown) => `solved-${key}`),
      fX: vi.fn(async () => ({ 'OpenAI-Sentinel-Turnstile-Token': 'result' })),
    };

    await resolveSentinel(mod as Record<string, unknown>);

    expect(mod.bi).toHaveBeenCalledWith('bx-key-123');
  });

  it('catches headerBuilder errors gracefully', async () => {
    const mod = {
      bk: vi.fn(async () => mockChatReqs),
      bi: vi.fn(async () => 'turnstile-token'),
      fX: vi.fn(async () => {
        throw new Error('fX exploded');
      }),
    };

    const { sentinelHeaders, sentinelError } = await resolveSentinel(mod as Record<string, unknown>);

    expect(sentinelError).toContain('fX exploded');
    expect(Object.keys(sentinelHeaders)).toHaveLength(0);
  });
});
