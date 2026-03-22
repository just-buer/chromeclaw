import { approvalRulesStorage } from '@extension/storage';
import type { ApprovalCondition, ApprovalRule } from '@extension/storage';
import {
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
import { ChevronDownIcon, ChevronRightIcon, PencilIcon, PlusIcon, ShieldAlertIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

// ── Helpers ──

const emptyCondition = (): ApprovalCondition => ({ type: 'always' });

const emptyRule = (): Omit<ApprovalRule, 'id'> => ({
  name: '',
  description: '',
  enabled: true,
  toolPattern: '*',
  condition: emptyCondition(),
  message: '',
  priority: 100,
});

const genId = () => `rule_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// ── Predefined templates ──

type RuleTemplate = {
  emoji: string;
  label: string;
  description: string;
  isCustom?: boolean;
  defaults: Omit<ApprovalRule, 'id'>;
};

const RULE_TEMPLATES: RuleTemplate[] = [
  {
    emoji: '🔍',
    label: 'AI 搜索时',
    description: '每次 AI 使用网络搜索时暂停确认',
    defaults: {
      name: 'AI 搜索时需确认',
      description: 'AI 调用 web_search 时请求用户确认',
      enabled: true,
      toolPattern: 'web_search',
      condition: { type: 'always' },
      message: '检测到 AI 正在进行网络搜索，是否允许？',
      priority: 100,
    },
  },
  {
    emoji: '🖱',
    label: 'AI 点击网页时',
    description: 'AI 控制浏览器点击任意元素时暂停',
    defaults: {
      name: 'AI 点击网页时需确认',
      description: 'AI 触发浏览器 click 动作时请求用户确认',
      enabled: true,
      toolPattern: 'browser',
      condition: { type: 'fieldEquals', field: 'action', value: 'click' },
      message: '检测到 AI 正在点击页面元素，是否允许？',
      priority: 100,
    },
  },
  {
    emoji: '🌐',
    label: 'AI 导航网页时',
    description: 'AI 控制浏览器跳转到新 URL 时暂停',
    defaults: {
      name: 'AI 导航网页时需确认',
      description: 'AI 触发浏览器 navigate 动作时请求用户确认',
      enabled: true,
      toolPattern: 'browser',
      condition: { type: 'fieldEquals', field: 'action', value: 'navigate' },
      message: '检测到 AI 正在导航到新页面，是否允许？',
      priority: 100,
    },
  },
  {
    emoji: '📜',
    label: 'AI 执行 JS 时',
    description: 'AI 在页面中运行 JavaScript 代码时暂停',
    defaults: {
      name: 'AI 执行 JavaScript 时需确认',
      description: 'AI 触发浏览器 evaluate 动作时请求用户确认',
      enabled: true,
      toolPattern: 'browser',
      condition: { type: 'fieldEquals', field: 'action', value: 'evaluate' },
      message: '检测到 AI 即将执行 JavaScript，是否允许？',
      priority: 100,
    },
  },
  {
    emoji: '📧',
    label: 'AI 发邮件时',
    description: 'AI 通过 Gmail 发送邮件时暂停',
    defaults: {
      name: 'AI 发送邮件时需确认',
      description: 'AI 调用 gmail_send 时请求用户确认',
      enabled: true,
      toolPattern: 'gmail_send',
      condition: { type: 'always' },
      message: '检测到 AI 即将发送邮件，请确认后继续。',
      priority: 10,
    },
  },
  {
    emoji: '📅',
    label: 'AI 创建日历事件时',
    description: 'AI 在 Google Calendar 中新建事件时暂停',
    defaults: {
      name: 'AI 创建日历事件时需确认',
      description: 'AI 调用 calendar_create 时请求用户确认',
      enabled: true,
      toolPattern: 'calendar_create',
      condition: { type: 'always' },
      message: '检测到 AI 即将新建日历事件，是否允许？',
      priority: 10,
    },
  },
  {
    emoji: '✏️',
    label: 'AI 写入文件时',
    description: 'AI 向工作区写入或修改文件时暂停',
    defaults: {
      name: 'AI 写入文件时需确认',
      description: 'AI 调用 write / edit 时请求用户确认',
      enabled: true,
      toolPattern: 'write',
      condition: { type: 'always' },
      message: '检测到 AI 正在写入文件，是否允许？',
      priority: 100,
    },
  },
  {
    emoji: '⚙️',
    label: '自定义规则',
    description: '手动配置工具名称和触发条件',
    isCustom: true,
    defaults: emptyRule(),
  },
];

// ── Field hint map — maps tool pattern prefixes to suggested fields ──

type FieldHint = { field: string; label: string };

const TOOL_FIELD_HINTS: Record<string, FieldHint[]> = {
  web_search: [{ field: 'query', label: '搜索词' }],
  web_fetch: [{ field: 'url', label: '目标地址' }],
  browser: [
    { field: 'action', label: '操作类型 (click/navigate/evaluate/type)' },
    { field: 'url', label: '目标 URL' },
    { field: 'expression', label: 'JS 表达式' },
  ],
  write: [
    { field: 'path', label: '文件路径' },
    { field: 'content', label: '文件内容' },
  ],
  edit: [
    { field: 'path', label: '文件路径' },
    { field: 'content', label: '修改内容' },
  ],
  gmail_send: [
    { field: 'to', label: '收件人' },
    { field: 'subject', label: '主题' },
    { field: 'body', label: '正文' },
  ],
  gmail_draft: [
    { field: 'to', label: '收件人' },
    { field: 'subject', label: '主题' },
    { field: 'body', label: '正文' },
  ],
  calendar_create: [
    { field: 'summary', label: '事件标题' },
    { field: 'start', label: '开始时间' },
  ],
  scheduler: [
    { field: 'action', label: '操作 (add/remove/update/run)' },
    { field: 'name', label: '任务名称' },
  ],
  execute_javascript: [{ field: 'code', label: 'JS 代码' }],
};

const getFieldHints = (toolPattern: string): FieldHint[] => {
  // Exact match first
  if (TOOL_FIELD_HINTS[toolPattern]) return TOOL_FIELD_HINTS[toolPattern];
  // Prefix/glob match: strip trailing * and find prefix match
  const base = toolPattern.replace(/\*$/, '');
  const key = Object.keys(TOOL_FIELD_HINTS).find(k => k.startsWith(base) || base.startsWith(k));
  return key ? TOOL_FIELD_HINTS[key] : [];
};

// ── Condition editor ──

type ConditionEditorProps = {
  condition: ApprovalCondition;
  toolPattern: string;
  onChange: (c: ApprovalCondition) => void;
};

const ConditionEditor = ({ condition, toolPattern, onChange }: ConditionEditorProps) => {
  const type = condition.type === 'and' || condition.type === 'or' ? 'always' : condition.type;
  const hints = getFieldHints(toolPattern);

  const FieldPathInput = ({
    value,
    onChangeValue,
  }: {
    value: string;
    onChangeValue: (v: string) => void;
  }) => (
    <div>
      <Label className="text-xs">字段路径 — 工具参数中的字段名</Label>
      <Input
        className="h-8 text-xs"
        onChange={e => onChangeValue(e.target.value)}
        placeholder="query"
        value={value}
      />
      {hints.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {hints.map(h => (
            <button
              className="bg-muted hover:bg-accent rounded px-1.5 py-0.5 font-mono text-xs transition-colors"
              key={h.field}
              onClick={() => onChangeValue(h.field)}
              title={h.label}
              type="button">
              {h.field}
              <span className="text-muted-foreground ml-1 font-sans not-italic">
                {h.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-2">
      <div>
        <Label className="text-xs">触发条件类型</Label>
        <Select
          onValueChange={v => {
            if (v === 'always') onChange({ type: 'always' });
            if (v === 'keyword') onChange({ type: 'keyword', field: '', keywords: [] });
            if (v === 'threshold') onChange({ type: 'threshold', field: '' });
            if (v === 'fieldEquals') onChange({ type: 'fieldEquals', field: '', value: '' });
          }}
          value={type}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="always">始终触发 — 工具被调用时</SelectItem>
            <SelectItem value="keyword">关键词匹配 — 参数值包含指定关键词时</SelectItem>
            <SelectItem value="threshold">数值阈值 — 参数数值超过设定值时</SelectItem>
            <SelectItem value="fieldEquals">字段等于 — 参数某字段等于指定值时</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {condition.type === 'keyword' && (
        <>
          <FieldPathInput
            onChangeValue={v => onChange({ ...condition, field: v })}
            value={condition.field}
          />
          <div>
            <Label className="text-xs">关键词 (逗号分隔)</Label>
            <Input
              className="h-8 text-xs"
              onChange={e =>
                onChange({
                  ...condition,
                  keywords: e.target.value
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="删除, 提交, 付款"
              value={condition.keywords.join(', ')}
            />
          </div>
        </>
      )}

      {condition.type === 'threshold' && (
        <>
          <FieldPathInput
            onChangeValue={v => onChange({ ...condition, field: v })}
            value={condition.field}
          />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">大于 (gt)</Label>
              <Input
                className="h-8 text-xs"
                onChange={e =>
                  onChange({
                    ...condition,
                    gt: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
                placeholder="1000"
                type="number"
                value={condition.gt ?? ''}
              />
            </div>
            <div>
              <Label className="text-xs">大于等于 (gte)</Label>
              <Input
                className="h-8 text-xs"
                onChange={e =>
                  onChange({
                    ...condition,
                    gte: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
                placeholder="500"
                type="number"
                value={condition.gte ?? ''}
              />
            </div>
          </div>
        </>
      )}

      {condition.type === 'fieldEquals' && (
        <>
          <FieldPathInput
            onChangeValue={v => onChange({ ...condition, field: v })}
            value={condition.field}
          />
          <div>
            <Label className="text-xs">期望值</Label>
            <Input
              className="h-8 text-xs"
              onChange={e => onChange({ ...condition, value: e.target.value })}
              placeholder="click"
              value={String(condition.value ?? '')}
            />
          </div>
        </>
      )}
    </div>
  );
};

// ── Rule dialog — two-stage: template picker + advanced ──

type RuleDialogProps = {
  open: boolean;
  initial: ApprovalRule | null;
  onClose: () => void;
  onSave: (rule: ApprovalRule) => void;
};

const RuleDialog = ({ open, initial, onClose, onSave }: RuleDialogProps) => {
  const [form, setForm] = useState<Omit<ApprovalRule, 'id'>>(emptyRule());
  const [selectedTemplate, setSelectedTemplate] = useState<number | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (open) {
      if (initial) {
        setForm({ ...initial });
        setSelectedTemplate(null);
        setAdvancedOpen(true);
      } else {
        setForm(emptyRule());
        setSelectedTemplate(null);
        setAdvancedOpen(false);
      }
    }
  }, [open, initial]);

  const update = <K extends keyof Omit<ApprovalRule, 'id'>>(
    key: K,
    value: Omit<ApprovalRule, 'id'>[K],
  ) => setForm(prev => ({ ...prev, [key]: value }));

  const applyTemplate = (idx: number) => {
    const tpl = RULE_TEMPLATES[idx];
    setSelectedTemplate(idx);
    setForm({ ...tpl.defaults });
    setAdvancedOpen(tpl.isCustom === true);
  };

  const handleSave = () => {
    if (!form.name.trim()) return;
    onSave({ ...form, id: initial?.id ?? genId() });
  };

  const isEditing = initial !== null;

  return (
    <Dialog onOpenChange={v => !v && onClose()} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? '编辑规则' : '新建审批规则'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? '修改规则配置后点击保存。'
              : '选择一个场景模板，AI 执行对应操作时会暂停等待您确认。'}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto py-1 pr-1">
          {/* ── Template grid (only when creating new) ── */}
          {!isEditing && (
            <div>
              <Label className="mb-2 block text-xs">选择场景</Label>
              <div className="grid grid-cols-4 gap-2">
                {RULE_TEMPLATES.map((tpl, idx) => (
                  <button
                    className={`flex flex-col items-center gap-1 rounded-lg border p-2.5 text-center transition-colors hover:bg-accent ${
                      selectedTemplate === idx
                        ? 'border-yellow-500 bg-yellow-50 dark:bg-yellow-950/30'
                        : ''
                    }`}
                    key={tpl.label}
                    onClick={() => applyTemplate(idx)}
                    title={tpl.description}
                    type="button">
                    <span className="text-xl leading-none">{tpl.emoji}</span>
                    <span className="text-muted-foreground leading-tight text-xs">{tpl.label}</span>
                  </button>
                ))}
              </div>
              {selectedTemplate !== null && !RULE_TEMPLATES[selectedTemplate].isCustom && (
                <p className="text-muted-foreground mt-1.5 text-xs">
                  {RULE_TEMPLATES[selectedTemplate].description}
                </p>
              )}
            </div>
          )}

          {/* ── Name & message (always visible) ── */}
          <div className="space-y-3">
            <div>
              <Label className="text-xs">规则名称 *</Label>
              <Input
                className="h-8 text-xs"
                onChange={e => update('name', e.target.value)}
                placeholder="高额订单审批"
                value={form.name}
              />
            </div>

            <div>
              <Label className="text-xs">用户提示消息 (选填)</Label>
              <Input
                className="h-8 text-xs"
                onChange={e => update('message', e.target.value)}
                placeholder="检测到高额操作，请确认后继续。"
                value={form.message ?? ''}
              />
              <p className="text-muted-foreground mt-1 text-xs">
                触发审批时展示给用户的说明文字。
              </p>
            </div>
          </div>

          {/* ── Advanced config (collapsible) ── */}
          <div className="rounded-md border">
            <button
              className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium"
              onClick={() => setAdvancedOpen(v => !v)}
              type="button">
              <span>高级配置（工具名称 / 触发条件）</span>
              {advancedOpen ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
            </button>

            {advancedOpen && (
              <div className="space-y-3 border-t px-3 py-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">工具名称匹配 (* 支持通配符)</Label>
                    <Input
                      className="h-8 font-mono text-xs"
                      onChange={e => update('toolPattern', e.target.value)}
                      placeholder="crm_*, form_submit"
                      value={form.toolPattern}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">优先级 (数字越小越先)</Label>
                    <Input
                      className="h-8 text-xs"
                      min={1}
                      onChange={e => update('priority', Number(e.target.value) || 100)}
                      type="number"
                      value={form.priority ?? 100}
                    />
                  </div>
                </div>

                <div>
                  <Label className="text-xs">描述 (内部备注)</Label>
                  <Input
                    className="h-8 text-xs"
                    onChange={e => update('description', e.target.value)}
                    placeholder="订单金额超过 1000 元需要确认"
                    value={form.description ?? ''}
                  />
                </div>

                <div className="rounded-md bg-muted/40 p-3">
                  <p className="mb-2 text-xs font-medium">触发条件</p>
                  <ConditionEditor
                    condition={form.condition}
                    onChange={c => update('condition', c)}
                    toolPattern={form.toolPattern}
                  />
                </div>
              </div>
            )}
          </div>

          {/* ── Enabled toggle ── */}
          <div className="flex items-center gap-2">
            <input
              checked={form.enabled}
              className="size-4 cursor-pointer accent-yellow-500"
              id="rule-enabled"
              onChange={e => update('enabled', e.target.checked)}
              type="checkbox"
            />
            <Label className="cursor-pointer text-xs" htmlFor="rule-enabled">
              启用此规则
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={onClose} size="sm" variant="outline">
            取消
          </Button>
          <Button disabled={!form.name.trim()} onClick={handleSave} size="sm">
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ── Main panel ──

const ApprovalRulesConfig = () => {
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ApprovalRule | null>(null);

  useEffect(() => {
    approvalRulesStorage.get().then(r => setRules(r ?? []));
    return approvalRulesStorage.subscribe(() => {
      approvalRulesStorage.get().then(r => setRules(r ?? []));
    });
  }, []);

  const persist = useCallback(async (updated: ApprovalRule[]) => {
    setRules(updated);
    await approvalRulesStorage.set(updated);
  }, []);

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (rule: ApprovalRule) => {
    setEditing(rule);
    setDialogOpen(true);
  };

  const handleSave = async (rule: ApprovalRule) => {
    const updated = editing
      ? rules.map(r => (r.id === rule.id ? rule : r))
      : [...rules, rule];
    await persist(updated);
    setDialogOpen(false);
  };

  const handleDelete = async (id: string) => {
    await persist(rules.filter(r => r.id !== id));
  };

  const handleToggleEnabled = async (id: string) => {
    await persist(rules.map(r => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  };

  const conditionSummary = (c: ApprovalCondition): string => {
    switch (c.type) {
      case 'always':
        return '始终触发';
      case 'keyword':
        return `关键词 [${c.keywords.slice(0, 3).join(', ')}${c.keywords.length > 3 ? '…' : ''}] in ${c.field}`;
      case 'threshold':
        return `${c.field} ${c.gt !== undefined ? `> ${c.gt}` : ''} ${c.gte !== undefined ? `≥ ${c.gte}` : ''}`.trim();
      case 'fieldEquals':
        return `${c.field} = ${c.value}`;
      case 'and':
        return `AND (${c.conditions.length} 条件)`;
      case 'or':
        return `OR (${c.conditions.length} 条件)`;
    }
  };

  // Map template emoji to rule for display
  const templateEmoji = (rule: ApprovalRule): string => {
    const match = RULE_TEMPLATES.find(
      t => !t.isCustom && t.defaults.toolPattern === rule.toolPattern,
    );
    return match?.emoji ?? '⚙️';
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlertIcon className="size-5 text-yellow-500" />
              <CardTitle>动态审批规则</CardTitle>
            </div>
            <Button onClick={openNew} size="sm" variant="outline">
              <PlusIcon className="mr-1 size-4" />
              新建规则
            </Button>
          </div>
          <CardDescription>
            配置 AI 执行哪些操作时需要您手动确认。支持按工具类型和参数内容精细控制。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              暂无规则。点击「新建规则」选择一个场景快速开始。
            </p>
          ) : (
            <div className="space-y-2">
              {[...rules]
                .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
                .map(rule => (
                  <div
                    className="flex items-center gap-3 rounded-md border p-3"
                    key={rule.id}>
                    <input
                      checked={rule.enabled}
                      className="size-4 cursor-pointer accent-yellow-500"
                      onChange={() => handleToggleEnabled(rule.id)}
                      type="checkbox"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{templateEmoji(rule)}</span>
                        <span className="truncate text-sm font-medium">{rule.name}</span>
                        <Badge className="font-mono text-xs" variant="secondary">
                          {rule.toolPattern}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground mt-0.5 truncate text-xs">
                        {conditionSummary(rule.condition)}
                        {rule.message ? ` · ${rule.message}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button onClick={() => openEdit(rule)} size="icon" variant="ghost">
                        <PencilIcon className="size-3.5" />
                      </Button>
                      <Button onClick={() => handleDelete(rule.id)} size="icon" variant="ghost">
                        <Trash2Icon className="size-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      <RuleDialog
        initial={editing}
        onClose={() => setDialogOpen(false)}
        onSave={handleSave}
        open={dialogOpen}
      />
    </>
  );
};

export { ApprovalRulesConfig };
