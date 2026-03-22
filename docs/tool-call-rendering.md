# Tool Call 渲染机制

## 1. 概述

当 LLM 决定调用工具时，Background Service Worker 通过 `chrome.runtime.Port` 将工具调用状态实时流式推送到 UI。UI 侧的 `useLLMStream` Hook 将流式数据合并进 React 状态，最终由消息组件渲染为可折叠卡片。

---

## 2. 类型定义

### `ToolPartState`

定义在 `packages/shared/lib/chat-types.ts`：

```typescript
type ToolPartState =
  | 'input-streaming'   // 参数仍在流式生成（类型中存在，但目前从未实际发出）
  | 'input-available'   // 参数完整，工具正在执行
  | 'output-available'  // 工具执行成功，结果已返回
  | 'output-error';     // 工具执行失败
```

### `ChatMessagePart`（工具相关）

```typescript
type ChatMessagePart =
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown>; result?: unknown; state?: ToolPartState }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; state?: ToolPartState }
  | ...
```

---

## 3. 数据流

### 完整链路

```
用户发送消息
  └─ useLLMStream.sendMessage()
       └─ chrome.runtime.connect({ name: 'llm-stream' })
            └─ port.postMessage({ type: 'LLM_REQUEST', ... })
                   ↓
            Background SW (index.ts → handleLLMStream)
                   ↓
            stream-handler.ts → runAgent()
                   ↓
            agent-loop.ts → runLoop() → executeToolCalls()
                   │
                   ├─ onToolCallEnd
                   │    └─ port.postMessage LLM_STREAM_CHUNK { toolCall, state: 'input-available' }
                   │
                   ├─ tool.execute() 执行中...
                   │
                   └─ onToolResult
                        └─ port.postMessage LLM_STREAM_CHUNK { toolResult, state: 'output-available' | 'output-error' }
                   ↓
            useLLMStream.handleChunk() → 更新 React 状态
                   ↓
            Messages → PreviewMessage → ToolCallPart → 渲染
```

### Port 消息类型（Background → UI 方向）

| 消息类型 | 触发时机 | 携带数据 |
|---|---|---|
| `LLM_STREAM_CHUNK { toolCall }` | `onToolCallEnd` 后，工具开始执行前 | `toolCall.id`, `toolCall.name`, `toolCall.args`, `state: 'input-available'` |
| `LLM_STREAM_CHUNK { toolResult }` | 工具执行完成后 | `toolResult.id`, `toolResult.result`, `state: 'output-available' \| 'output-error'` |
| `LLM_STREAM_CHUNK { toolResult, files }` | 工具产出附件（如截图）时 | 附加 `files` 数组，UI 追加 `file` 类型 part |

---

## 4. `useLLMStream` 状态管理

Hook 位于 `packages/shared/lib/hooks/use-llm-stream.ts`，维护一个 `assistantMessage`，以 `toolCallId` 为 key 对 tool call part 进行 upsert：

**收到 `toolCall` chunk 时**（新建或更新 part）：

```typescript
if (chunk.toolCall) {
  updateAssistantPart(parts => {
    const existing = parts.find(
      p => p.type === 'tool-call' && p.toolCallId === chunk.toolCall!.id
    );
    if (existing) {
      // 状态转换：更新 state + args
      return parts.map(p =>
        p.type === 'tool-call' && p.toolCallId === chunk.toolCall!.id
          ? { ...p, state: chunk.state as ToolPartState, args: chunk.toolCall!.args }
          : p,
      );
    }
    // 新建 part
    return [...parts, { type: 'tool-call', toolCallId: ..., toolName: ..., args: ..., state: ... }];
  });
}
```

**收到 `toolResult` chunk 时**（更新 result + state）：

```typescript
if (chunk.toolResult) {
  updateAssistantPart(parts =>
    parts.map(p =>
      p.type === 'tool-call' && p.toolCallId === chunk.toolResult!.id
        ? { ...p, result: chunk.toolResult!.result, state: chunk.state ?? 'output-available' }
        : p,
    )
  );
  // 若有附件（截图等），追加 file part
  if (chunk.toolResult.files?.length) { ... }
}
```

---

## 5. 状态机

单个 tool call part 的状态生命周期：

```
                ┌──────────────────┐
  新建 part ──→ │ input-streaming  │  (参数流式中，目前未使用)
                └────────┬─────────┘
                         │ onToolCallEnd
                ┌────────▼─────────┐
                │ input-available  │  (参数完整，执行中，显示脉冲时钟)
                └────────┬─────────┘
              成功 │         │ 失败
       ┌───────────▼──┐  ┌──▼──────────────┐
       │output-available│  │  output-error   │
       │  (绿色对勾)   │  │  (红色叉号)     │
       └───────────────┘  └─────────────────┘
```

---

## 6. UI 组件层级

### 组件树

```
Messages (packages/ui/lib/components/messages.tsx)
  └─ PreviewMessage
       └─ ToolCallPart (packages/ui/lib/components/message.tsx)
            └─ Tool (packages/ui/lib/components/elements/tool.tsx)
                 ├─ ToolHeader   ← 状态徽章 + 工具名
                 └─ ToolContent
                      ├─ ToolInput   ← 格式化 JSON 参数
                      └─ ToolOutput  ← 结果渲染
                           └─ ToolResultRenderer ← 结果格式化
```

### `Tool`（`packages/ui/lib/components/elements/tool.tsx`）

基础 UI 原语，使用 shadcn/ui `<Collapsible>`。四种状态的视觉表现：

| `ToolPartState` | 徽章文字 | 图标 | 颜色 |
|---|---|---|---|
| `input-streaming` | Pending | `CircleIcon` | 中性 |
| `input-available` | Running | `ClockIcon` (animate-pulse) | 中性 |
| `output-available` | Completed | `CheckCircleIcon` | 绿色 |
| `output-error` | Error | `XCircleIcon` | 红色 |

### `ToolCallPart`（`packages/ui/lib/components/message.tsx`）

按状态决定渲染内容：

```typescript
const ToolCallPart = ({ part, state, toolName, args, result }) => (
  <Tool defaultOpen={true}>
    <ToolHeader name={toolName} state={state} />
    <ToolContent>
      {/* 参数：input-available / output-available / output-error 时展示 */}
      {(state === 'input-available' || state === 'output-available' || state === 'output-error') && (
        <ToolInput input={args} />
      )}

      {/* 成功结果 */}
      {state === 'output-available' && result != null && (
        <ToolOutput output={<ToolResultRenderer result={result} toolName={toolName} />} />
      )}

      {/* 错误信息 */}
      {state === 'output-error' && result != null && (
        <ToolOutput errorText={typeof result === 'string' ? result : JSON.stringify(result)} output={null} />
      )}
    </ToolContent>
  </Tool>
);
```

### `ToolResultRenderer`

特殊处理 `web_search` 工具，渲染为富文本 `<SearchResults>`；其余工具统一渲染为 `<pre>JSON.stringify(result)</pre>`。

文档工具（`isDocumentToolCall` 判断）在 `ToolCallPart` 之前有独立分支，渲染 `<DocumentPreview>`。

---

## 7. 关键文件索引

| 文件 | 职责 |
|---|---|
| `packages/shared/lib/chat-types.ts` | `ToolPartState`、`ChatMessagePart`、所有 Port 消息类型定义 |
| `packages/shared/lib/hooks/use-llm-stream.ts` | Chrome Port 客户端；合并 chunk 到 React 状态；暴露 `sendMessage` |
| `packages/ui/lib/components/elements/tool.tsx` | `Tool`、`ToolHeader`、`ToolContent`、`ToolInput`、`ToolOutput` 原语 |
| `packages/ui/lib/components/message.tsx` | `ToolCallPart`、`ToolResultRenderer`；按状态组装 UI |
| `packages/ui/lib/components/messages.tsx` | `Messages` 列表；路由每条消息到 `PreviewMessage` |
| `chrome-extension/src/background/agents/stream-handler.ts` | 后台流处理器；发出所有 `LLM_STREAM_CHUNK` |
| `chrome-extension/src/background/agents/agent-loop.ts` | `runLoop` + `executeToolCalls`；工具实际执行入口 |
| `chrome-extension/src/background/tools/index.ts` | 工具注册表；`getAgentTools`、`executeTool` |
| `chrome-extension/src/background/tools/tool-registration.ts` | `ToolRegistration` 接口定义 |
