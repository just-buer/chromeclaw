# Tool 审批（Human-in-the-Loop）方案设计

## 1. 背景与目标

### 现状

当前工具执行流程完全自动化：LLM 决定调用工具 → Background 立即执行 → 结果返回 LLM → LLM 继续。UI 只能被动观察工具的调用与结果，没有任何介入手段。

唯一的「防护」仅有：
- **工具循环检测**（`agent-loop-detection.ts`）：阻止重复调用相同工具
- **工具超时**（`TOOL_TIMEOUT_MS = 300_000`）：防止工具挂死
- **Prompt 工程**：对 Gmail/Calendar/Drive 等工具的系统提示中包含「执行前请先向用户确认」的指令，但这依赖 LLM 自律，不是程序性保障

### 目标

在 LLM 决定调用工具（参数已确定）和工具实际执行（产生副作用）之间插入一个**可选的人工审批暂停点**：

- 对特定工具，后台暂停执行，向 UI 发送审批请求
- UI 渲染「同意 / 拒绝」按钮
- 用户做出选择后，后台继续（或取消）执行

本方案分为两个层次：
1. **静态审批**（已实现）：基于工具名的固定配置，适合通用场景
2. **动态审批规则引擎**（扩展方案）：基于工具参数内容的条件评估，适合 toB CRM / 审核系统

---

## 2. 整体架构

### 审批决策流程

```
LLM 决定调用工具（onToolCallEnd）
  └─ executeToolCalls() 调用 evaluateApprovalRules(toolName, args)
       │
       ├─ 所有规则均不命中 → 直接 tool.execute()（无感执行）
       │
       └─ 任一规则命中 → 挂起 Promise
                          └─ port.postMessage LLM_TOOL_APPROVAL_REQUEST
                               └─ UI 渲染 Approve / Deny 按钮（含命中规则说明）
                                    └─ 用户点击
                                         └─ port.postMessage LLM_TOOL_APPROVAL_RESPONSE
                                              ├─ approved=true  → 解析 Promise → tool.execute()
                                              └─ approved=false → 注入拒绝结果 → LLM 收到错误继续对话
```

### 审批判断三层优先级

```
① 动态规则（approvalRulesStorage）       ← 最高优先级，内容感知
② 用户静态配置（requireApprovalTools）   ← 用户 override
③ 开发者默认（ToolRegistration.requiresApproval） ← 最低优先级
```

任意一层返回 `true` 即需要审批。

### Port 协议扩展

在 `packages/shared/lib/chat-types.ts` 中新增两种消息类型：

```typescript
// Background → UI：请求审批
interface LLMToolApprovalRequest {
  type: 'LLM_TOOL_APPROVAL_REQUEST';
  chatId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  matchedRule?: { name: string; message?: string }; // 动态规则命中时填充
}

// UI → Background：用户决策
interface LLMToolApprovalResponse {
  type: 'LLM_TOOL_APPROVAL_RESPONSE';
  toolCallId: string;
  approved: boolean;
  denyReason?: string;
}
```

### `ToolPartState` 扩展

新增 `'pending-approval'` 状态，插入在 `input-available` 之后：

```
input-streaming → input-available → [pending-approval] → output-available
                                                        ↘ output-error
```

UI 表现：黄色警告徽章 + `ShieldAlertIcon`，标签文字「Awaiting approval」。

---

## 3. 第一层：静态审批（已实现）

### 3.1 `AgentTool` 扩展类型

`AgentTool`（来自 `pi-agent-core`）通过本地 wrapper 携带 `requiresApproval` 字段：

```typescript
// chrome-extension/src/background/tools/index.ts
type ExtendedAgentTool = AgentTool & { requiresApproval?: boolean };
```

### 3.2 `ToolRegistration` 接口（`tool-registration.ts`）

```typescript
interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  schema: TObject;
  excludeInHeadless?: boolean;
  chromeOnly?: boolean;
  needsContext?: boolean;
  requiresApproval?: boolean;  // 开发者设置的默认值
  execute: (args: any, context?: ToolContext) => Promise<unknown>;
  formatResult?: (result: unknown) => ToolResult;
}
```

### 3.3 `getAgentTools`（`tools/index.ts`）

构建 `AgentTool` 时，合并开发者默认值与用户配置：

```typescript
const config = await toolConfigStorage.get();

tools.push({
  name: def.name,
  // ...
  requiresApproval:
    config.requireApprovalTools?.[def.name] ??  // 用户配置优先
    def.requiresApproval ??                      // 回退到开发者默认
    false,
  execute: async (_toolCallId, params) => { ... },
});
```

### 3.4 默认标记为 `requiresApproval: true` 的内置工具

| 工具文件 | 工具名 | 原因 |
|---|---|---|
| `execute-js.ts` | `execute_javascript` | 在页面上下文执行任意 JS |
| `google-gmail.ts` | `gmail_send`, `gmail_draft` | 发送/创建邮件 |
| `google-calendar.ts` | `calendar_create`, `calendar_update`, `calendar_delete` | 修改日历数据 |
| `google-drive.ts` | `drive_create` | 创建 Drive 文件 |

只读工具（`web_search`、`web_fetch`、`memory_*`、`workspace_read` 等）保持全自动，默认 `false`。

### 3.5 `agent-loop.ts`（`executeToolCalls`）

```typescript
const executeToolCalls = async (tools, assistantMessage, signal, stream,
  getSteeringMessages, toolLoopState, onApprovalRequest) => {

  for (const toolCall of toolCalls) {
    const tool = tools?.find(t => t.name === toolCall.name);

    const needsApproval = (tool as ExtendedAgentTool)?.requiresApproval ?? false;
    if (needsApproval && onApprovalRequest) {
      const decision = await onApprovalRequest(toolCall.id, toolCall.name, toolCall.arguments);
      if (!decision.approved) {
        // 注入拒绝结果，LLM 收到错误后会重新规划
        injectDeniedResult(toolCall, decision.denyReason, stream, results);
        continue;
      }
    }

    // 正常执行
    result = await tool.execute(toolCall.id, validatedArgs, signal, ...);
  }
};
```

### 3.6 `stream-handler.ts`

```typescript
// 挂起审批 Promise，chatId 级别隔离
const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
const activeApprovalResolvers = new Map<string, (r: LLMToolApprovalResponse) => void>();

const onApprovalRequest = async (toolCallId, toolName, args) => {
  // 更新 UI 状态为 pending-approval
  sendChunk(port, { chatId, toolCall: { id: toolCallId, name: toolName, args },
    state: 'pending-approval' });

  // 发送审批请求消息
  safeSend(port, { type: 'LLM_TOOL_APPROVAL_REQUEST', chatId, toolCallId, toolName, args });

  // 挂起等待用户响应
  return new Promise(resolve => { pendingApprovals.set(toolCallId, resolve); });
};
```

### 3.7 `index.ts`（Port 连接入口）

```typescript
port.onMessage.addListener((msg) => {
  if (msg.type === 'LLM_REQUEST') {
    handleLLMStream(port, msg);
  }
  if (msg.type === 'LLM_TOOL_APPROVAL_RESPONSE') {
    handleApprovalResponse(msg); // 路由到 stream-handler 的 resolver
  }
});
```

---

## 4. 第二层：动态审批规则引擎（toB 扩展）

> 适用场景：CRM、ERP、OA、审批系统等需要基于**业务内容**动态判断是否需要人工确认的场景。

### 4.1 背景与问题

静态审批只能回答「**哪个工具**需要审批」，无法回答「**在什么情况下**需要审批」。

对于 toB 系统，真正需要的是：
- `crm_update({ amount: 100 })` → **不需要**审批
- `crm_update({ amount: 500000 })` → **需要**审批（金额超阈值）
- `form_submit({ action: "submit_review" })` → **需要**审批（关键动作）
- `customer_delete({ mode: "batch", count: 200 })` → **需要**审批（批量高风险操作）

### 4.2 `ApprovalRule` 数据结构

```typescript
// packages/storage/lib/impl/approval-rules-storage.ts

type ApprovalCondition =
  | { type: 'always' }
  | {
      type: 'keyword';
      field: string;         // 工具参数的字段路径，如 "action" 或 "meta.type"
      keywords: string[];    // 包含任意一个即触发
      caseSensitive?: boolean;
    }
  | {
      type: 'threshold';
      field: string;         // 数值字段路径
      gt?: number;           // 大于
      gte?: number;          // 大于等于
      lt?: number;           // 小于
      lte?: number;          // 小于等于
    }
  | {
      type: 'fieldEquals';
      field: string;
      value: string | number | boolean;
    }
  | {
      type: 'and';
      conditions: ApprovalCondition[]; // 所有条件同时满足
    }
  | {
      type: 'or';
      conditions: ApprovalCondition[]; // 任一条件满足
    };

interface ApprovalRule {
  id: string;
  name: string;            // 规则名称，如"高额订单审批"
  description?: string;
  enabled: boolean;
  /** 工具名 glob 匹配，支持 * 通配符，如 "crm_*"、"form_submit" */
  toolPattern: string;
  condition: ApprovalCondition;
  /** 审批弹窗中展示给用户的说明 */
  message?: string;
  /** 规则优先级，数字越小越先评估（默认 100） */
  priority?: number;
}
```

### 4.3 规则评估器

```typescript
// chrome-extension/src/background/tools/approval-rules-evaluator.ts

const getNestedValue = (obj: Record<string, unknown>, path: string): unknown => {
  return path.split('.').reduce((curr: unknown, key) =>
    curr && typeof curr === 'object' ? (curr as Record<string, unknown>)[key] : undefined,
    obj
  );
};

const evaluateCondition = (
  condition: ApprovalCondition,
  args: Record<string, unknown>,
): boolean => {
  switch (condition.type) {
    case 'always':
      return true;

    case 'keyword': {
      const raw = getNestedValue(args, condition.field);
      const value = String(raw ?? '');
      const target = condition.caseSensitive ? value : value.toLowerCase();
      return condition.keywords.some(kw =>
        target.includes(condition.caseSensitive ? kw : kw.toLowerCase())
      );
    }

    case 'threshold': {
      const value = Number(getNestedValue(args, condition.field));
      if (isNaN(value)) return false;
      if (condition.gt !== undefined && !(value > condition.gt)) return false;
      if (condition.gte !== undefined && !(value >= condition.gte)) return false;
      if (condition.lt !== undefined && !(value < condition.lt)) return false;
      if (condition.lte !== undefined && !(value <= condition.lte)) return false;
      return true;
    }

    case 'fieldEquals':
      return getNestedValue(args, condition.field) === condition.value;

    case 'and':
      return condition.conditions.every(c => evaluateCondition(c, args));

    case 'or':
      return condition.conditions.some(c => evaluateCondition(c, args));
  }
};

const matchesToolPattern = (toolName: string, pattern: string): boolean => {
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${regexStr}$`).test(toolName);
};

export const evaluateApprovalRules = (
  toolName: string,
  args: Record<string, unknown>,
  rules: ApprovalRule[],
): { needsApproval: boolean; matchedRule?: ApprovalRule } => {
  const sorted = [...rules]
    .filter(r => r.enabled && matchesToolPattern(toolName, r.toolPattern))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  for (const rule of sorted) {
    if (evaluateCondition(rule.condition, args)) {
      return { needsApproval: true, matchedRule: rule };
    }
  }

  return { needsApproval: false };
};
```

### 4.4 存储层

```typescript
// packages/storage/lib/impl/approval-rules-storage.ts

const approvalRulesStorage = createStorage<ApprovalRule[]>('approval-rules', [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});
```

### 4.5 与现有静态审批的集成

在 `stream-handler.ts` 的 `onApprovalRequest` 回调中，动态规则作为额外检查层：

```typescript
// stream-handler.ts
const rules = await approvalRulesStorage.get();

const onApprovalRequest = async (toolCallId, toolName, args) => {
  // 动态规则评估（已在 agent-loop 层之前判断，此处是 stream 层补充 matchedRule 信息）
  const { matchedRule } = evaluateApprovalRules(toolName, args, rules);

  sendChunk(port, { chatId, toolCall: { id: toolCallId, name: toolName, args },
    state: 'pending-approval' });

  safeSend(port, {
    type: 'LLM_TOOL_APPROVAL_REQUEST', chatId, toolCallId, toolName, args,
    matchedRule: matchedRule ? { name: matchedRule.name, message: matchedRule.message } : undefined,
  });

  return new Promise(resolve => { pendingApprovals.set(toolCallId, resolve); });
};
```

在 `getAgentTools`（`tools/index.ts`）中，将动态规则评估纳入审批判断：

```typescript
// 构建 execute 包装器时，注入动态规则检查
// 在 agent-loop.executeToolCalls 调用 onApprovalRequest 前，
// evaluateApprovalRules 的结果会影响 needsApproval 的最终值：

const needsApproval =
  evaluateApprovalRules(toolName, args, rules).needsApproval  // 动态规则
  || config.requireApprovalTools?.[toolName]                  // 用户静态 override
  || tool.requiresApproval                                    // 开发者默认
  || false;
```

### 4.6 审批弹窗展示命中规则

当动态规则触发时，UI 的审批卡片应展示命中规则的说明：

```tsx
{state === 'pending-approval' && (
  <div className="flex flex-col gap-3 border-t px-4 py-3">
    {approvalRequest?.matchedRule && (
      <div className="rounded-md bg-yellow-50 border border-yellow-200 px-3 py-2 text-sm">
        <span className="font-medium text-yellow-800">
          ⚠ {approvalRequest.matchedRule.name}
        </span>
        {approvalRequest.matchedRule.message && (
          <p className="mt-1 text-yellow-700">{approvalRequest.matchedRule.message}</p>
        )}
      </div>
    )}
    <div className="flex items-center justify-between">
      <p className="text-sm text-muted-foreground">此操作需要您的确认。</p>
      <div className="flex gap-2">
        <button onClick={() => onDeny?.(toolCallId, '')} ...>拒绝</button>
        <button onClick={() => onApprove?.(toolCallId)} ...>同意执行</button>
      </div>
    </div>
  </div>
)}
```

### 4.7 规则管理 UI（Settings → Tools → 审批规则）

在 Settings 的 Tools tab 中新增「审批规则」子面板：

```
┌─ 审批规则 ─────────────────────────────────────────────────────┐
│                                              [+ 新建规则]      │
│                                                               │
│ ┌──────────────────────────────────────────────────────────┐  │
│ │ ✅ 高额订单审批                              [编辑] [删除] │  │
│ │    触发：crm_create_order · amount > 10000              │  │
│ │    提示：订单金额超过阈值，需要管理员审批                   │  │
│ └──────────────────────────────────────────────────────────┘  │
│                                                               │
│ ┌──────────────────────────────────────────────────────────┐  │
│ │ ✅ 批量操作拦截                              [编辑] [删除] │  │
│ │    触发：customer_* · mode 含 "batch"、"bulk"            │  │
│ │    提示：批量客户操作存在风险，请确认                        │  │
│ └──────────────────────────────────────────────────────────┘  │
│                                                               │
│ ┌──────────────────────────────────────────────────────────┐  │
│ │ ❌ 表单关键提交（已禁用）                     [编辑] [删除] │  │
│ │    触发：form_submit · action 含 "approve", "submit"     │  │
│ └──────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

规则编辑器（Dialog）：

```
┌─ 新建审批规则 ──────────────────────────────────────────────────┐
│                                                               │
│ 规则名称   [高额订单审批                              ]         │
│ 说明       [订单金额超过阈值，需要管理员审批            ]         │
│                                                               │
│ 触发工具   [crm_create_order        ]  （支持 * 通配符）        │
│                                                               │
│ 触发条件   ○ 始终触发                                          │
│           ● 字段阈值  字段 [amount    ] 大于 [10000    ]       │
│           ○ 关键词匹配 字段 [          ] 关键词 [        ]      │
│           ○ 字段等于  字段 [          ] 值 [           ]       │
│                                                               │
│ 审批提示   [订单金额 {amount} 元，超出 ¥10,000 阈值            ] │
│           （支持 {字段名} 占位符，运行时替换为实际参数值）         │
│                                                               │
│                              [取消]  [保存规则]               │
└───────────────────────────────────────────────────────────────┘
```

### 4.8 典型 toB 场景规则示例

**CRM 系统**

```json
[
  {
    "name": "高额商机关单",
    "toolPattern": "salesforce_opportunity_update",
    "condition": {
      "type": "and",
      "conditions": [
        { "type": "fieldEquals", "field": "stageName", "value": "Closed Won" },
        { "type": "threshold", "field": "amount", "gt": 100000 }
      ]
    },
    "message": "关单金额超过 ¥100,000，需要销售主管审批"
  },
  {
    "name": "客户数据批量删除",
    "toolPattern": "crm_*",
    "condition": { "type": "keyword", "field": "operation", "keywords": ["delete", "bulk_remove", "批量删除"] },
    "message": "检测到批量删除操作，此操作不可逆，请谨慎确认"
  }
]
```

**OA 审批系统**

```json
[
  {
    "name": "请假审批提交",
    "toolPattern": "oa_form_submit",
    "condition": { "type": "keyword", "field": "formType", "keywords": ["leave", "请假", "出差"] },
    "message": "即将提交请假申请，请确认申请信息无误"
  },
  {
    "name": "大额费用报销",
    "toolPattern": "expense_submit",
    "condition": { "type": "threshold", "field": "totalAmount", "gte": 5000 },
    "message": "报销金额 ≥ ¥5,000，需要财务主管审批"
  }
]
```

**内容审核系统**

```json
[
  {
    "name": "内容批量下架",
    "toolPattern": "content_*",
    "condition": {
      "type": "and",
      "conditions": [
        { "type": "keyword", "field": "action", "keywords": ["offline", "remove", "下架"] },
        { "type": "threshold", "field": "count", "gt": 10 }
      ]
    },
    "message": "即将批量下架 {count} 条内容，请确认操作"
  }
]
```

---

## 5. 用户配置

### 5.1 内置工具：`ToolConfig.requireApprovalTools`

```typescript
interface ToolConfig {
  enabledTools: Record<string, boolean>;
  requireApprovalTools: Record<string, boolean>;  // key = 工具名
  webSearchConfig: WebSearchProviderConfig;
  deepResearchConfig?: DeepResearchConfig;
  googleClientId?: string;
}
```

**优先级**（运行时合并）：
```
动态规则命中
  || 用户配置 requireApprovalTools[toolName]
  || 开发者默认 ToolRegistration.requiresApproval
  || false
```

### 5.2 内置工具配置 UI（`tool-config.tsx`）

每个工具行右侧，紧贴现有「启用」checkbox 左边加「审批」toggle：

```
┌──────────────────────────────────────────────────────────┐
│ Gmail Send                         [审批 ☑] [启用 ☑]    │
│ Send an email via Gmail...                               │
│                                                          │
│ Execute JavaScript                 [审批 ☑] [启用 ☑]    │
│ Execute JS code in sandboxed tab...                      │
└──────────────────────────────────────────────────────────┘
```

### 5.3 MCP 远程工具配置（`McpServerConfig`）

```typescript
interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  apiKey?: string;
  enabled: boolean;
  transport?: 'streamable-http' | 'sse';
  requireApproval?: boolean;                       // server 级默认
  toolApprovalOverrides?: Record<string, boolean>; // 单工具覆盖
}
```

运行时判断（`remote-mcp.ts`）：

```typescript
const needsApproval =
  server.toolApprovalOverrides?.[tool.name] ??
  server.requireApproval ??
  false;
```

### 5.4 MCP 配置 UI（`mcp-config.tsx`）

Test Connection 成功后展示 per-tool 审批配置：

```
┌─ Edit MCP Server ──────────────────────────────────────────┐
│ Name / URL / Transport / API Key ...                       │
│                                                            │
│ [Test Connection]  ✅ Connected — 5 tools                  │
│                                                            │
│ ┌─ 审批配置 ──────────────────────────────────────────────┐ │
│ │ 服务器默认：所有工具不需要审批              [toggle ○]  │ │
│ │ ─────────────────────────────────────────────────────  │ │
│ │ read_file   Read files from disk          [toggle ○]  │ │
│ │ write_file  Write content to files        [toggle ●] ↺ │ │
│ │ delete_file Delete files                  [toggle ●] ↺ │ │
│ │ list_dir    List directory contents       [toggle ○]  │ │
│ └────────────────────────────────────────────────────────┘ │
│ （● = 已覆盖，↺ = 点击重置为服务器默认）                     │
│                                         [Save Changes]     │
└────────────────────────────────────────────────────────────┘
```

---

## 6. 前端 UI 实现

### 6.1 `packages/ui/lib/components/elements/tool.tsx`

```typescript
const statusLabels: Record<ToolPartState, string> = {
  'input-streaming': 'Pending',
  'input-available': 'Running',
  'pending-approval': 'Awaiting approval',
  'output-available': 'Completed',
  'output-error': 'Error',
};

const statusIcons: Record<ToolPartState, ReactNode> = {
  'input-streaming': <CircleIcon className="size-4" />,
  'input-available': <ClockIcon className="size-4 animate-pulse" />,
  'pending-approval': <ShieldAlertIcon className="size-4 text-yellow-500" />,
  'output-available': <CheckCircleIcon className="size-4 text-green-600" />,
  'output-error': <XCircleIcon className="size-4 text-red-600" />,
};
```

### 6.2 `packages/ui/lib/components/message.tsx`（`ToolCallPart`）

```tsx
{state === 'pending-approval' && (
  <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
    <p className="text-muted-foreground flex-1 text-sm">
      此工具调用需要您的确认才能执行。
    </p>
    <div className="flex shrink-0 gap-2">
      <button variant="outline" onClick={() => onDeny?.(toolCallId, '')}>
        拒绝
      </button>
      <button onClick={() => onApprove?.(toolCallId)}>
        同意执行
      </button>
    </div>
  </div>
)}
```

`ToolCallPart` 新增 props：
```typescript
interface ToolCallPartProps {
  // 现有 props...
  onApprove?: (toolCallId: string) => void;
  onDeny?: (toolCallId: string, reason: string) => void;
}
```

### 6.3 `packages/shared/lib/hooks/use-llm-stream.ts`

```typescript
// 接收审批请求，更新 UI 状态
const handleApprovalRequest = useCallback((req: LLMToolApprovalRequest) => {
  updateAssistantPart(parts =>
    parts.map(p =>
      p.type === 'tool-call' && p.toolCallId === req.toolCallId
        ? { ...p, state: 'pending-approval' as ToolPartState }
        : p,
    ),
  );
}, [updateAssistantPart]);

// 发送用户决策到后台
const approveToolCall = useCallback(
  (toolCallId: string, approved: boolean, denyReason?: string) => {
    portRef.current?.postMessage({
      type: 'LLM_TOOL_APPROVAL_RESPONSE',
      toolCallId,
      approved,
      denyReason,
      chatId,
    });
  },
  [chatId],
);

return { ..., approveToolCall };
```

### 6.4 Chat 页面透传链路

```
useLLMStream().approveToolCall
  → chat.tsx: onApprove / onDeny
    → Messages: onApprove / onDeny props
      → PreviewMessage: onApprove / onDeny props
        → ToolCallPart: onApprove / onDeny
```

---

## 7. 改动文件汇总

### 类型 / 存储层

| 文件 | 改动 |
|---|---|
| `packages/shared/lib/chat-types.ts` | `ToolPartState` 加 `'pending-approval'`；新增 `LLMToolApprovalRequest`（含 `matchedRule`）、`LLMToolApprovalResponse` 类型 |
| `packages/storage/lib/impl/tool-config-storage.ts` | `ToolConfig` 加 `requireApprovalTools: Record<string, boolean>`；默认值初始化 |
| `packages/storage/lib/impl/mcp-servers-storage.ts` | `McpServerConfig` 加 `requireApproval`、`toolApprovalOverrides` |
| `packages/storage/lib/impl/approval-rules-storage.ts` | **新增**：`ApprovalRule` 类型定义；`approvalRulesStorage` |

### 后台层

| 文件 | 改动 |
|---|---|
| `chrome-extension/src/background/tools/tool-registration.ts` | `ToolRegistration` 加 `requiresApproval?: boolean` |
| `chrome-extension/src/background/tools/index.ts` | `ExtendedAgentTool` 类型；`getAgentTools` 合并用户配置、开发者默认与动态规则 |
| `chrome-extension/src/background/tools/approval-rules-evaluator.ts` | **新增**：`evaluateCondition`、`matchesToolPattern`、`evaluateApprovalRules` |
| `chrome-extension/src/background/tools/remote-mcp.ts` | 构建 `AgentTool` 时读取 `McpServerConfig` 审批配置 |
| `chrome-extension/src/background/tools/google-gmail.ts` | `gmail_send`、`gmail_draft` 标记 `requiresApproval: true` |
| `chrome-extension/src/background/tools/google-calendar.ts` | `calendar_create/update/delete` 标记 `requiresApproval: true` |
| `chrome-extension/src/background/tools/google-drive.ts` | `drive_create` 标记 `requiresApproval: true` |
| `chrome-extension/src/background/tools/execute-js.ts` | `execute_javascript` 标记 `requiresApproval: true` |
| `chrome-extension/src/background/agents/agent-loop.ts` | `executeToolCalls` 加审批挂起逻辑；`onApprovalRequest` 参数透传 |
| `chrome-extension/src/background/agents/agent.ts` | `AgentOptions` + `Agent` 类支持 `onApprovalRequest` |
| `chrome-extension/src/background/agents/agent-setup.ts` | `RunAgentOpts`、`executeAttempt`、`runAgent` 全链路透传 `onApprovalRequest` |
| `chrome-extension/src/background/agents/stream-handler.ts` | `onApprovalRequest` 回调；`activeApprovalResolvers`；`handleApprovalResponse` 导出；两处路径清理 resolver |
| `chrome-extension/src/background/index.ts` | `port.onMessage` 路由 `LLM_TOOL_APPROVAL_RESPONSE` |

### 前端层

| 文件 | 改动 |
|---|---|
| `packages/ui/lib/components/elements/tool.tsx` | `pending-approval` 视觉状态（黄色徽章 + `ShieldAlertIcon`） |
| `packages/ui/lib/components/message.tsx` | `ToolCallPart` 审批按钮；`onApprove`/`onDeny` props |
| `packages/ui/lib/components/messages.tsx` | `MessagesProps` 透传 `onApprove`/`onDeny` |
| `packages/ui/lib/components/chat.tsx` | 从 `useLLMStream` 解构 `approveToolCall`，传入 `Messages` |
| `packages/ui/lib/components/first-run-setup.tsx` | `toolConfigStorage.set()` 补充 `requireApprovalTools: {}` |
| `packages/shared/lib/hooks/use-llm-stream.ts` | 处理 `LLM_TOOL_APPROVAL_REQUEST`；暴露 `approveToolCall()` |
| `packages/config-panels/lib/tool-config.tsx` | 每个工具行加「审批」toggle；`handleApprovalToggle` handler |
| `packages/config-panels/lib/mcp-config.tsx` | `ServerDialog` 加 server 级 toggle + per-tool 审批配置行 |
| `packages/config-panels/lib/approval-rules-config.tsx` | **新增**：规则列表 + 规则编辑 Dialog |

---

## 8. 非功能性考量

### 8.1 超时处理

审批挂起期间，若用户关闭 Side Panel（Port 断开），`pendingApprovals` 里的 Promise 永远不会 resolve。需要在 `port.onDisconnect` 时自动拒绝所有挂起审批：

```typescript
port.onDisconnect.addListener(() => {
  activeApprovalResolvers.delete(chatId);
  // stream-handler 内部对所有 pendingApprovals 注入拒绝结果
  for (const [id, resolve] of pendingApprovals) {
    resolve({ approved: false, denyReason: 'UI disconnected' });
    pendingApprovals.delete(id);
  }
});
```

### 8.2 Headless 模式（Channel / Cron）

Headless 模式下没有 UI，无法弹出审批对话框。推荐策略：

- **策略 A（推荐）**：自动拒绝，向 LLM 返回 `"Tool requires human approval, skipped in headless mode"`，LLM 会感知此限制并调整行为
- **策略 B**：忽略审批标志，直接执行（等同于当前行为，适合内部自动化任务）

通过 `ToolRegistration.approvalSkipInHeadless?: boolean` 字段控制每个工具的 headless 行为。

### 8.3 并发工具调用

若 LLM 在同一轮次发起多个工具调用（部分模型支持并行工具调用），每个工具的审批请求独立挂起，UI 需要同时显示多个待审批状态。`pendingApprovals` Map 已天然支持多 key 并存，UI 侧 `ToolPartState` 中每个 `tool-call` part 独立持有 `pending-approval` 状态，互不干扰。

### 8.4 动态规则的安全性

- 规则中的 `field` 路径使用点号分隔的安全路径遍历，不支持原型链访问（`__proto__`、`constructor` 等被过滤）
- 规则评估为纯函数，无副作用，不执行任何代码
- 暂不支持 `custom` 表达式条件（需沙盒化 JS 执行，风险较高）；如需支持，可通过 offscreen 页面的 `execute-js` 沙盒实现

### 8.5 审计日志

对于 toB 场景，建议将所有审批决策记录到 IndexedDB（`approvalLogs` table）：

```typescript
interface ApprovalLog {
  id: string;
  chatId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  matchedRuleId?: string;
  approved: boolean;
  denyReason?: string;
  decidedAt: number;
}
```

审计日志可在 Settings → Usage 面板中查阅，也可导出为 CSV。
