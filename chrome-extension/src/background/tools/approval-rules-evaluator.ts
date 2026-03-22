import type { ApprovalCondition, ApprovalRule } from '@extension/storage';

/**
 * Safely read a nested field value from an object using a dot-separated path.
 * e.g. getField({ a: { b: 3 } }, 'a.b') => 3
 */
const getField = (obj: Record<string, unknown>, path: string): unknown => {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
};

/**
 * Returns true when the condition matches the given tool args.
 */
const matchesCondition = (
  condition: ApprovalCondition,
  args: Record<string, unknown>,
): boolean => {
  switch (condition.type) {
    case 'always':
      return true;

    case 'keyword': {
      const raw = getField(args, condition.field);
      const text = typeof raw === 'string' ? raw : String(raw ?? '');
      const haystack = condition.caseSensitive ? text : text.toLowerCase();
      return condition.keywords.some(kw => {
        const needle = condition.caseSensitive ? kw : kw.toLowerCase();
        return haystack.includes(needle);
      });
    }

    case 'threshold': {
      const raw = getField(args, condition.field);
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isNaN(num)) return false;
      if (condition.gt !== undefined && !(num > condition.gt)) return false;
      if (condition.gte !== undefined && !(num >= condition.gte)) return false;
      if (condition.lt !== undefined && !(num < condition.lt)) return false;
      if (condition.lte !== undefined && !(num <= condition.lte)) return false;
      return true;
    }

    case 'fieldEquals': {
      const raw = getField(args, condition.field);
      return raw === condition.value;
    }

    case 'and':
      return condition.conditions.every(c => matchesCondition(c, args));

    case 'or':
      return condition.conditions.some(c => matchesCondition(c, args));

    default:
      return false;
  }
};

/**
 * Matches a tool name against a simple glob pattern (only * wildcard supported).
 */
const matchesPattern = (toolName: string, pattern: string): boolean => {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return toolName === pattern;
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${regexStr}$`).test(toolName);
};

/**
 * Evaluate all enabled rules against the given tool call.
 * Returns the first matching rule (sorted by priority asc), or null if no match.
 */
const evaluateApprovalRules = (
  toolName: string,
  args: Record<string, unknown>,
  rules: ApprovalRule[],
): ApprovalRule | null => {
  const sorted = [...rules]
    .filter(r => r.enabled)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  for (const rule of sorted) {
    if (matchesPattern(toolName, rule.toolPattern) && matchesCondition(rule.condition, args)) {
      return rule;
    }
  }
  return null;
};

export { evaluateApprovalRules, matchesCondition, matchesPattern, getField };
