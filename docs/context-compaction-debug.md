# Context Compaction: Design, Debug Analysis & Gap Report

## 1. How ChromeClaw Compacts (Proactive)

ChromeClaw compacts **before every LLM call**. The `transformContext` hook runs in the background service worker before each `streamSimple()` call.

### Pipeline (1000 messages, claude-opus-4.6, 200K context window)

```
1000 messages arrive at transformContext()
         │
         ▼
┌─────────────────────────────────────┐
│  STEP 1: Tool Result Budget Guard   │  (tool-result-context-guard.ts)
│                                     │
│  Per-result cap: 50% of context     │
│  Global cap: 75% of context         │
│  Walks oldest→newest, replaces      │
│  oversized results with placeholder │
│  → 1000 msgs, large results capped  │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  STEP 2: Repair Transcript          │  (tool-result-sanitization.ts)
│                                     │
│  Remove empty/duplicate messages    │
│  Fix role ordering violations       │
│  Repair orphaned tool-call/result   │
│  → ~995 messages                    │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  STEP 3: Preprocess Tool Results    │  (compaction.ts)
│                                     │
│  a) Truncate any result > 50K chars │
│     (HARD_MAX_TOOL_RESULT_CHARS)    │
│     Head+tail strategy, strips      │
│     base64 data first               │
│                                     │
│  b) Compact oldest results:         │
│     Walk oldest→newest, replace     │
│     tool results with placeholder   │
│     until total chars < budget      │
│  → 995 msgs, tool results smaller   │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  STEP 4: Token Estimation & Check   │
│                                     │
│  effectiveLimit = 200K × 0.75       │
│                 = 150K tokens       │
│  budget = 150K - 4K system prompt   │
│         = 146K tokens               │
│                                     │
│  Estimation: chars / 3 (conservative│
│  for JSON/code), base64 at 1:1     │
│  Safety margin: × 1.25             │
│                                     │
│  If adjustedTotal ≤ budget → DONE   │
│  Otherwise → must compact           │
└─────────────────┬───────────────────┘
                  │ (over budget)
                  ▼
┌─────────────────────────────────────┐
│  STEP 5: maxHistoryShare Guard      │
│                                     │
│  cap = budget × 0.5 = 73K tokens   │
│  Any message > 73K gets its tool    │
│  results truncated to fit cap       │
│  Processes ALL oversized messages   │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  STEP 6: Split OLDER vs RECENT      │
│                                     │
│  Anchor: first user message         │
│  Reserve: 2000 tokens for summary   │
│  remainingBudget ≈ 144K tokens      │
│                                     │
│  Walk backward from end:            │
│  - Add to recent if fits budget     │
│  - Force-keep min 4 messages        │
│  - Force-keep last user turn        │
│    (capped to 4 messages)           │
│  - Stop when budget exhausted       │
│                                     │
│  Example:                           │
│    recent = msgs[700..994] (~295)   │
│    older  = msgs[1..699]  (~699)    │
│                                     │
│  If recent > 80% budget:            │
│    Truncate tool results in recent  │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  STEP 7: Summarize OLDER messages   │
│                                     │
│  a) Sanitize: strip tool details    │
│     to 1000 chars each              │
│  b) If > 60% of limit: truncate    │
│  c) If > 1.5× context: adaptive    │
│     (split into 2-8 parts,         │
│      summarize each in parallel,    │
│      merge partial summaries)       │
│     Otherwise: single-pass          │
│                                     │
│  Structured prompt: 7 sections      │
│  (KEY DECISIONS, OPEN TODOs,        │
│   CONSTRAINTS, PENDING USER ASKS,   │
│   EXACT IDENTIFIERS, TOOL FAILURES, │
│   CURRENT TASK STATE)               │
│  maxTokens: 1200                    │
│                                     │
│  Quality audit: identifier overlap, │
│  section presence, user ask check   │
│  Retry up to 2× on audit failure   │
│                                     │
│  Append last 3 turns verbatim       │
│  3-minute timeout → sliding-window  │
│  fallback on failure                │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  STEP 8: Assemble Result            │
│                                     │
│  final = [anchor, summary, ...recent]│
│  Repair tool pairing                │
│  Enforce hard token limit           │
│                                     │
│  ~296 messages, ~146K tokens        │
│  Dropped: ~700 messages             │
│  Summary persisted to IndexedDB     │
│  (used as existingSummary next time)│
└─────────────────────────────────────┘
```

### Key constants

| Constant | Value | Location |
|---|---|---|
| `HARD_MAX_TOOL_RESULT_CHARS` | 50,000 | compaction.ts |
| `MIN_RECENT_MESSAGES` | 4 | compaction.ts |
| `TOKEN_SAFETY_MARGIN` | 1.25 | compaction.ts |
| `CHARS_PER_TOKEN_ESTIMATE` | 3 | compaction.ts |
| `MAX_HISTORY_SHARE` | 0.5 | compaction.ts |
| `MAX_TOOL_RESULT_CONTEXT_SHARE` | 0.3 | compaction.ts |
| `CONTEXT_RATIO` | 0.75 | context-limits.ts |
| `MAX_SUMMARY_CHARS` | 8,000 | summarizer.ts |
| `COMPACTION_TIMEOUT_MS` | 180,000 (3 min) | compaction.ts |
| `MAX_SUMMARY_COMPACTION_ATTEMPTS` | 3 | transform.ts |

### What happens on subsequent calls

Each LLM response + tool result appends to the message array. The pipeline runs again on the next call. If `existingSummary` is set (from a previous compaction), it's prepended to the older messages as context for the new summary, creating a rolling summary chain.

After 3 summary compactions in one stream, falls back to sliding-window only (no LLM summarization) to prevent infinite compaction loops.

---

## 2. How OpenClaw Compacts (Reactive)

OpenClaw is a **server-side Node.js application** that delegates compaction to `pi-coding-agent`'s `session.compact()` and adds a 3-tier overflow recovery layer.

### Architecture: Two compaction layers

1. **SDK-level**: `pi-coding-agent`'s `session.compact()` — auto-compacts during `session.prompt()`
2. **Application-level**: `run.ts` overflow recovery — wraps the SDK with retry logic

### Pipeline (1000 messages, claude-opus-4.6, 200K context window)

```
1000 messages in SessionManager (file-based)
         │
         ▼
┌─────────────────────────────────────────┐
│  LAYER 1: session.prompt("user input")  │
│  (pi-coding-agent SDK)                  │
│                                         │
│  SDK builds context from session file   │
│  and sends to LLM API.                  │
│                                         │
│  If context too large, SDK may          │
│  auto-compact BEFORE sending.           │
│  Uses model-aware tokenization          │
│  (not just chars/3 heuristic).          │
└─────────────────┬───────────────────────┘
                  │
          ┌───────┴───────┐
          │  API call OK?  │
          └───┬───────┬───┘
            YES       NO (overflow error)
              │         │
              ▼         ▼
         (continue)   LAYER 2: run.ts overflow recovery
```

### LAYER 2: Overflow Recovery

```
┌─────────────────────────────────────────┐
│  TIER 1: Detect & Classify              │
│                                         │
│  Parse error: "prompt is too long:      │
│  250,000 tokens > 200,000 maximum"      │
│                                         │
│  isLikelyContextOverflowError():        │
│    Matches: "context.*overflow",        │
│    "prompt.*too large", etc.            │
│    Excludes: TPM rate limits, billing   │
│                                         │
│  extractObservedOverflowTokenCount():   │
│    Parses actual token count from error │
│    → observedTokens = 250000            │
│                                         │
│  isCompactionFailureError():            │
│    If "summarization failed" + overflow │
│    → Skip compaction (death spiral)     │
│    → Go to TIER 3 directly             │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│  TIER 2: Compaction (max 3 attempts)    │
│                                         │
│  Branch A: SDK already compacted?       │
│    YES → just retry (SDK will compact   │
│           again with updated counts)    │
│    NO  → explicit compaction:           │
│                                         │
│  contextEngine.compact({                │
│    force: true,                         │
│    compactionTarget: "budget",          │
│    tokenBudget: 200K,                   │
│    currentTokenCount: 250000            │  ← real count from error
│  })                                     │
│                                         │
│  Internally (pi-coding-agent):          │
│  ┌───────────────────────────────────┐  │
│  │ a) Strip toolResult.details       │  │
│  │ b) Model-aware token estimation   │  │
│  │ c) pruneHistoryForContextShare()  │  │
│  │    Drop oldest chunks until       │  │
│  │    ≤ 50% of context window        │  │
│  │    Repair orphaned tool_results   │  │
│  │ d) session.compact(instructions)  │  │
│  │    LLM summarizes pruned history  │  │
│  │ e) 5-min safety timeout           │  │
│  └───────────────────────────────────┘  │
│                                         │
│  Fire before/after compaction hooks     │
│  overflowCompactionAttempts++           │
│  If succeeded → retry prompt            │
│  If failed OR attempts ≥ 3 → TIER 3    │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│  TIER 3: Tool Result Truncation         │
│  (one-shot)                             │
│                                         │
│  sessionLikelyHasOversizedToolResults() │
│  → truncateOversizedToolResultsIn       │
│    Session({ contextWindowTokens })     │
│                                         │
│  PERMANENTLY modifies session file      │
│  Hard cap: 400K chars per result        │
│  Head+tail with importance detection    │
│  (errors, JSON closings, summaries)     │
│                                         │
│  If truncation helped → retry           │
│  If not → GIVE UP                       │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│  TERMINAL: Graceful failure             │
│                                         │
│  "Context overflow: prompt too large    │
│   for the model. Try /reset (or /new)   │
│   to start a fresh session, or use a    │
│   larger-context model."                │
│                                         │
│  Includes: diagId, attempt count,       │
│  provider, model, observed tokens       │
└─────────────────────────────────────────┘
```

### Concrete example flow

```
Attempt 1: 1000 msgs → API → "250K tokens > 200K maximum"
  isCompactionFailure? No
  SDK auto-compacted? No → explicit compact(currentTokenCount=250000)
  pi-coding-agent prunes oldest 600 msgs, summarizes → 120K tokens
  overflowCompactionAttempts = 1 → retry

Attempt 2: ~400 msgs → API → success (120K < 200K)
  Done.

── Or if it still overflows ──

Attempt 2: API → "210K > 200K" → compact again
  overflowCompactionAttempts = 2 → retry

Attempt 3: API → "205K > 200K" → compact again
  overflowCompactionAttempts = 3 → retry

Attempt 4: API → still overflows
  attempts ≥ 3, compaction exhausted
  → Try tool result truncation (one-shot)
  → Permanently truncate biggest results on disk
  → retry

Attempt 5: still overflows after truncation
  → GIVE UP, return error to user
```

### Key constants

| Constant | Value | Location |
|---|---|---|
| `MAX_OVERFLOW_COMPACTION_ATTEMPTS` | 3 | run.ts |
| `BASE_RUN_RETRY_ITERATIONS` | 24 | run.ts |
| `MIN_RUN_RETRY_ITERATIONS` | 32 | run.ts |
| `MAX_RUN_RETRY_ITERATIONS` | 160 | run.ts |
| `EMBEDDED_COMPACTION_TIMEOUT_MS` | 300,000 (5 min) | compaction-safety-timeout.ts |
| `BASE_CHUNK_RATIO` | 0.4 | compaction.ts |
| `SAFETY_MARGIN` | 1.2 | compaction.ts |
| `SUMMARIZATION_OVERHEAD_TOKENS` | 4,096 | compaction.ts |

---

## 3. Side-by-Side Comparison

| Aspect | ChromeClaw | OpenClaw |
|---|---|---|
| **When compacts** | Before every LLM call (proactive) | After API overflow error (reactive) |
| **Token estimation** | Heuristic: chars / 3 | Model-aware tokenization + real counts from errors |
| **Session storage** | IndexedDB, never modified by compaction | File-based, permanently modified by truncation |
| **Compaction engine** | Custom (compaction.ts + summarizer.ts) | pi-coding-agent's `session.compact()` |
| **Summarization** | Custom structured prompt (7 sections), quality audit | pi-coding-agent's built-in `generateSummary` |
| **Recent preservation** | 4 messages + last user turn boundary | SDK-managed turn preservation |
| **Fallback chain** | Summary → sliding-window → (loop, max 3 summaries) | SDK auto-compact → explicit compact (×3) → truncation (×1) → error |
| **Terminal state** | Falls back to sliding-window indefinitely | Clear error to user |
| **Truncation persistence** | In-memory only (original preserved in IndexedDB) | Permanent session file modification |
| **Base64 handling** | Explicit stripping (data URLs + JSON values) | Not needed (server-side, no browser CDP) |
| **Compaction timeout** | 3 minutes | 5 minutes |
| **Overflow detection** | Token estimate before call | Parse actual error from API response |
| **Quality audit** | Identifier overlap, section presence, user ask | None (trusts pi-coding-agent's summarizer) |
| **Hooks** | None | before/after compaction hooks for plugins |

---

## 4. Gaps in ChromeClaw vs OpenClaw

### Gap 1: ~~No graceful failure~~ — ALREADY IMPLEMENTED
**OpenClaw**: Returns "Context overflow, try /reset" after exhausting all tiers.
**ChromeClaw**: `agent-setup.ts` already has `MAX_RETRY_ATTEMPTS = 3` with graceful error: *"Context overflow: conversation too long after retries. Try starting a new chat or using a model with a larger context window."*

### Gap 2: ~~No post-API overflow detection~~ — ALREADY IMPLEMENTED
**OpenClaw**: Detects overflow after API rejection, classifies error.
**ChromeClaw**: `error-classification.ts` already has `isContextOverflowError()`, `isLikelyContextOverflowError()`, `isCompactionFailureError()`, and `classifyError()` with the same pattern matching. The `agent-setup.ts` retry loop uses `classifyError()` to detect `context-overflow` and trigger retry.

### Gap 3: ~~No separate truncation fallback tier~~ — ALREADY IMPLEMENTED
**OpenClaw**: Tries tool result truncation as a last resort after compaction fails.
**ChromeClaw**: `agent-setup.ts` already checks `hasOversizedToolResults()` and calls `truncateToolResults()` as a separate strategy before retrying. The retry loop tries truncation first when oversized results exist, then falls back to compaction-based retry.

### Gap 4: ~~No compaction-failure classification~~ — ALREADY IMPLEMENTED
**OpenClaw**: `isCompactionFailureError()` detects compaction death spirals.
**ChromeClaw**: `error-classification.ts` has `isCompactionFailureError()` and `agent-setup.ts` checks it: `if (isCompactionFailureError(result.error)) return result;` — stops retrying immediately.

### Gap 5 (Low): Partial — token limit parsed but not passed to compactor
**OpenClaw**: Parses `currentTokenCount` from error message and passes it to `contextEngine.compact()` for precise budget targeting.
**ChromeClaw**: `parseProviderTokenLimit()` extracts the limit from error messages and stores it in `provider-limit-cache.ts`. The `transformContext` hook reads this via `setProviderLimit()`. However, it only uses it to lower the effective context window — it doesn't pass the actual observed token count to the compactor for precise targeting.

### Gap 6 (Low): No permanent truncation
**OpenClaw**: `truncateOversizedToolResultsInSession()` permanently modifies the session file.
**ChromeClaw**: Truncates in-memory only. The original oversized result in IndexedDB is re-loaded on every compaction pass. This is by design — ChromeClaw preserves full history in IndexedDB for the user to review.

### Gap 7 (Low): No compaction hooks
**OpenClaw**: Fires before/after hooks for plugins.
**ChromeClaw**: Not needed for extension architecture.

### Summary: What was actually missing

Upon deeper code review, **Gaps 1-4 were already implemented** in `agent-setup.ts` and `error-classification.ts`. The original debug analysis was looking at the wrong layer — the `transformContext` compaction pipeline (which runs pre-call) already had the proactive approach, and the `agent-setup.ts` retry loop (which runs post-error) already had the reactive approach matching OpenClaw's pattern.

The real root cause of the original bug was not missing overflow recovery — it was:
1. `MIN_RECENT_MESSAGES = 2` was too low (fixed → 4)
2. Summary prompt didn't capture current task state (fixed → added CURRENT TASK STATE section)
3. `HARD_MAX_TOOL_RESULT_CHARS = 100K` was too high for browser CDP (fixed → 50K)
4. maxHistoryShare guard only truncated first oversized message (fixed → all)
5. Sliding-window could report negative savings (fixed → abort guard)
6. No limit on summary compaction attempts per stream (fixed → max 3)
