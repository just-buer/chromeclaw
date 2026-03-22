import { createStorage, StorageEnum } from '../base/index.js';

// ── ApprovalCondition types ──

type ApprovalConditionAlways = { type: 'always' };

type ApprovalConditionKeyword = {
  type: 'keyword';
  /** Dot-separated field path within tool args, e.g. "action" or "meta.type" */
  field: string;
  keywords: string[];
  caseSensitive?: boolean;
};

type ApprovalConditionThreshold = {
  type: 'threshold';
  /** Dot-separated field path to a numeric value */
  field: string;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
};

type ApprovalConditionFieldEquals = {
  type: 'fieldEquals';
  field: string;
  value: string | number | boolean;
};

type ApprovalConditionAnd = {
  type: 'and';
  conditions: ApprovalCondition[];
};

type ApprovalConditionOr = {
  type: 'or';
  conditions: ApprovalCondition[];
};

type ApprovalCondition =
  | ApprovalConditionAlways
  | ApprovalConditionKeyword
  | ApprovalConditionThreshold
  | ApprovalConditionFieldEquals
  | ApprovalConditionAnd
  | ApprovalConditionOr;

// ── ApprovalRule ──

interface ApprovalRule {
  id: string;
  /** Human-readable rule name, e.g. "高额订单审批" */
  name: string;
  description?: string;
  enabled: boolean;
  /**
   * Glob-like tool name pattern. Supports * wildcard.
   * Examples: "crm_*", "form_submit", "*"
   */
  toolPattern: string;
  condition: ApprovalCondition;
  /** Message shown to the user in the approval card when this rule fires */
  message?: string;
  /** Lower number = evaluated first (default: 100) */
  priority?: number;
}

// ── Storage ──

const approvalRulesStorage = createStorage<ApprovalRule[]>('approval-rules', [], {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export type {
  ApprovalRule,
  ApprovalCondition,
  ApprovalConditionAlways,
  ApprovalConditionKeyword,
  ApprovalConditionThreshold,
  ApprovalConditionFieldEquals,
  ApprovalConditionAnd,
  ApprovalConditionOr,
};
export { approvalRulesStorage };
