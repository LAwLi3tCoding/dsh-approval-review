/**
 * The plugin's browser-side copy: one dictionary namespace, two languages.
 *
 * The ledger follows the HARNESS's language preference, not the browser's. That
 * preference is owned by the locale plugin (Settings → General → Language), and
 * it reaches every slot entry that declares this namespace as the framework's
 * synthesized `t` seat: the renderer re-derives each entry's translate function
 * from (namespace, revision) and re-renders its outlets on a switch, so a
 * language change needs no subscription of this plugin's own.
 *
 * Scope: only copy this plugin AUTHORED lives here. Text recorded into the
 * session log — the reviewer's rationale, the asker's reason, a command's own
 * output — is frozen at the moment it is written and is deliberately left
 * alone: the log is immutable and the model already read that exact text, so
 * re-translating it later would make this tab disagree with the transcript.
 * @module dsh-approval-review/client/locale
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin. */
export const LOCALE_NS = 'approval-review'

/** Every key this plugin's copy can be addressed by. */
export type ApprovalReviewKey =
  /** Conversation tab title. */
  | 'tab'
  /** Ledger header. */
  | 'title'
  /** Header state while the projection has not landed yet. */
  | 'noData'
  /** Header state while auto-approval is on. */
  | 'autoOn'
  /** Header state while auto-approval is off. */
  | 'autoOff'
  /** Header switch: turn auto-approval on. */
  | 'enable'
  /** Header switch: turn auto-approval off. */
  | 'disable'
  /** Field label AND header prefix for the reviewer route. */
  | 'reviewer'
  /** Header value when the reviewer inherits the session route. */
  | 'inheritSession'
  /** Button that clears the reviewer-model override. */
  | 'inherit'
  /** Header counters; `{total}` `{reviewed}` `{refused}` `{turn}` `{max}` `{streak}`. */
  | 'summary'
  /** Prefix of a slash command the host refused. */
  | 'commandRefused'
  /** Rejection circuit-breaker banner. */
  | 'breaker'
  /** Empty-ledger explanation. */
  | 'empty'
  /** Verdict tag: the reviewer has not answered yet. */
  | 'pending'
  /** Verdict tag: refused. */
  | 'refused'
  /** Verdict tag: allowed once. */
  | 'allowed'
  /** Verdict tag: handed to the human answerer. */
  | 'delegated'
  /** Routing tag: a `never` rule hard-stopped the request. */
  | 'tagHardDisabled'
  /** Routing tag: a `human` rule handed the request back. */
  | 'tagDelegated'
  /** Risk prefix. */
  | 'risk'
  /** Risk grade: lowest. */
  | 'riskLow'
  /** Risk grade: moderate. */
  | 'riskMedium'
  /** Risk grade: high. */
  | 'riskHigh'
  /** Risk grade: critical. */
  | 'riskCritical'
  | 'authorization'
  | 'authUnknown'
  /** Tag: the row carries a one-shot human authorization. */
  | 'override'
  /** Field label: the reviewer's rationale. */
  | 'rationaleLabel'
  /** Field label: the safer alternative the reviewer proposed. */
  | 'saferPath'
  /** Field label: which rule routed the request. */
  | 'routing'
  /** Field label: the asker's own reason. */
  | 'askedWhy'
  /** Suffix: the reviewer reported it could not decide. */
  | 'uncertain'
  /** Toggle: reveal the arguments preview. */
  | 'showArgs'
  /** Toggle: hide the arguments preview. */
  | 'hideArgs'
  /** One-shot override button; `{n}` is the denial ordinal. */
  | 'approveRetry'
  /** Rationale fallback: no reviewer ran under the `never` policy. */
  | 'reasonNever'
  /** Rationale fallback: a `human` rule delegated it. */
  | 'reasonHuman'
  /** Rationale fallback: refused with nothing persisted. */
  | 'reasonRefusedMissing'
  /** Rationale fallback: allowed with nothing persisted. */
  | 'reasonAllowedMissing'
  /** Picker aria-label. */
  | 'pickModel'
  /** Picker placeholder. */
  | 'pickPlaceholder'
  /** Picker empty state: the host publishes no catalog at all. */
  | 'noModels'
  /** Picker empty state: the draft matches nothing. */
  | 'noMatch'

/** Namespace-bound translate function for this plugin's copy. */
export type ApprovalReviewTranslate = Translate<ApprovalReviewKey>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Ledger tab, audit rows, and the reviewer-model picker. */
    'approval-review': ApprovalReviewKey
  }
}

/** Chinese copy. */
export const zh: Record<ApprovalReviewKey, string> = {
  tab: '审批',
  title: '审批审计',
  noData: '尚无数据',
  autoOn: '自动审批已开启',
  autoOff: '自动审批已关闭',
  enable: '开启',
  disable: '关闭',
  reviewer: '复核模型',
  inheritSession: '继承会话',
  inherit: '继承',
  summary: '共 {total} 次 · 本插件裁决 {reviewed} · 已否决 {refused} · 本回合复审 {turn}/{max} · 连续否决 {streak}',
  commandRefused: '命令被拒：',
  breaker: '否决熔断已触发：本回合后续请求转人工审批。',
  empty: '本会话还没有审批记录。当某个动作需要越过沙箱边界时，这里会留下完整的裁决理由、风险等级与更安全的替代做法。',
  pending: '进行中',
  refused: '否决',
  allowed: '放行',
  delegated: '转人工',
  tagHardDisabled: '硬禁用',
  tagDelegated: '交还人工',
  authorization: '用户授权',
  authUnknown: '未知',
  risk: '风险',
  riskLow: '低',
  riskMedium: '中',
  riskHigh: '高',
  riskCritical: '严重',
  override: '含人工一次性授权',
  rationaleLabel: '裁决理由',
  saferPath: '更安全的做法',
  routing: '路由策略',
  askedWhy: '申请理由',
  uncertain: '不确定',
  showArgs: '查看参数',
  hideArgs: '收起参数',
  approveRetry: '授权重试第 {n} 条否决',
  reasonNever: '按 never 策略硬禁用，没有经过复核模型。',
  reasonHuman: '已交还人工应答者，本插件没有裁决这一次。',
  reasonRefusedMissing: '被否决，但本行没有留下理由记录。',
  reasonAllowedMissing: '已放行；本行没有留下理由记录（该请求未走到复核模型，或核可理由未落盘）。',
  pickModel: '复核模型',
  pickPlaceholder: '选择或输入模型',
  noModels: '没有可选模型，直接输入 id 后回车',
  noMatch: '没有匹配的模型',
}

/**
 * English copy. It is also the fallback the locale catalog lands on for any
 * language added later, which is why every key must exist here.
 */
export const en: Record<ApprovalReviewKey, string> = {
  tab: 'Approvals',
  title: 'Approval audit',
  noData: 'no data',
  autoOn: 'auto-approval on',
  autoOff: 'auto-approval off',
  enable: 'on',
  disable: 'off',
  reviewer: 'reviewer',
  inheritSession: 'inherit session',
  inherit: 'inherit',
  summary: '{total} total · {reviewed} routed to the reviewer · {refused} refused · this turn {turn}/{max} · streak {streak}',
  commandRefused: 'command refused: ',
  breaker: 'Rejection breaker is open: later requests in this turn go to the human chain.',
  empty: 'No approvals recorded in this session yet. When an action needs to cross the sandbox boundary, its full rationale, risk grade, and safer alternative land here.',
  pending: 'pending',
  refused: 'refused',
  allowed: 'allowed',
  delegated: 'delegated',
  tagHardDisabled: 'hard-disabled',
  tagDelegated: 'delegated',
  authorization: 'user authorization',
  authUnknown: 'unknown',
  risk: 'risk',
  riskLow: 'low',
  riskMedium: 'medium',
  riskHigh: 'high',
  riskCritical: 'critical',
  override: 'human override',
  rationaleLabel: 'rationale',
  saferPath: 'safer path',
  routing: 'routing',
  askedWhy: 'asked why',
  uncertain: 'uncertain',
  showArgs: 'show arguments',
  hideArgs: 'hide arguments',
  approveRetry: 'approve denial #{n} for one retry',
  reasonNever: 'Hard-disabled by the never policy; no reviewer ran.',
  reasonHuman: 'Delegated to the human answerer; this plugin did not decide it.',
  reasonRefusedMissing: 'Refused, but no rationale was recorded.',
  reasonAllowedMissing: 'Allowed, but no rationale was recorded (the request never reached the reviewer, or its allow rationale was not persisted).',
  pickModel: 'reviewer model',
  pickPlaceholder: 'pick or type a model',
  noModels: 'no models to pick from — type an id and press Enter',
  noMatch: 'no matching model',
}
