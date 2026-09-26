import { z } from 'zod';
import { ACTION_TYPES } from '../domain/action-types';
import { ROLES } from '../domain/roles';

export const KNOWLEDGE_KINDS = {
  strategy: '攻略策略',
  rule: '规则参考',
  case: '案例分析',
} as const;
export const KNOWLEDGE_ACTION_TYPES = [
  ACTION_TYPES.SPEECH,
  ACTION_TYPES.VOTE,
  ACTION_TYPES.DAY_END_JUDGMENT,
  ACTION_TYPES.GUARD_PROTECT,
  ACTION_TYPES.SEER_CHECK,
  ACTION_TYPES.WITCH_DECISION,
  ACTION_TYPES.HUNTER_SHOT,
  ACTION_TYPES.WOLF_PROPOSAL,
  ACTION_TYPES.WOLF_DISCUSSION_CONTINUE,
  ACTION_TYPES.WOLF_KILL,
  ACTION_TYPES.WOLF_EXPLODE,
  ACTION_TYPES.WOLF_KING_SHOT,
  ACTION_TYPES.WHITE_WOLF_TAKE,
  ACTION_TYPES.SHERIFF_CANDIDACY,
  ACTION_TYPES.SHERIFF_WITHDRAW,
  ACTION_TYPES.SHERIFF_TRANSFER,
  ACTION_TYPES.SHERIFF_DECIDE_ORDER,
] as const;
export const KnowledgeSourceSchema = z.object({
  title: z.string().trim().min(1).max(160),
  url: z
    .url()
    .max(600)
    .refine((url) => /^https?:\/\//.test(url), '来源须为 HTTP 或 HTTPS 链接'),
  publisher: z.string().trim().min(1).max(80),
  author: z.string().trim().max(80),
  locator: z.string().trim().min(1).max(160),
  publishedOn: z.iso.date().nullable(),
  checkedOn: z.iso.date(),
});
export const KnowledgeContentSchema = z
  .object({
    kind: z.enum(['strategy', 'rule', 'case']),
    title: z.string().trim().min(1).max(64),
    body: z.string().trim().min(1).max(600),
    conditions: z.string().trim().min(1).max(240),
    adaptation: z.string().trim().min(1).max(300),
    rulesBasis: z.string().trim().min(1).max(160),
    boardIds: z.array(z.string().min(1).max(64)).max(10),
    roles: z.array(z.enum(Object.values(ROLES))).max(8),
    actionTypes: z.array(z.enum(KNOWLEDGE_ACTION_TYPES)).max(12),
    firstDayOnly: z.boolean(),
    minDay: z.number().int().min(1).max(20).default(1),
    sources: z.array(KnowledgeSourceSchema).min(1).max(3),
  })
  .superRefine((value, ctx) => {
    if (value.firstDayOnly && value.minDay !== 1)
      ctx.addIssue({ code: 'custom', path: ['minDay'], message: '仅首日与最早适用天数冲突' });
    if (value.kind === 'strategy') {
      for (const field of ['boardIds', 'roles', 'actionTypes'] as const)
        if (!value[field].length)
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: '策略必须明确适用板子、角色和行动',
          });
    }
    for (const field of ['boardIds', 'roles', 'actionTypes'] as const)
      if (new Set(value[field]).size !== value[field].length)
        ctx.addIssue({ code: 'custom', path: [field], message: '适用范围不能重复' });
  });
export const KnowledgeSnapshotSchema = z.object({
  id: z.uuid(),
  versionId: z.uuid(),
  version: z.number().int().positive(),
  content: KnowledgeContentSchema,
});
export const KNOWLEDGE_LIMIT = 2;
export const KNOWLEDGE_CHARACTERS = 2400;
export const KnowledgeVersionSchema = KnowledgeSnapshotSchema.extend({
  status: z.enum(['draft', 'pending', 'ready', 'failed', 'unknown']),
  failure: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: z.string(),
});
export const KnowledgeItemSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  activeVersionId: z.uuid().nullable(),
  versions: z.array(KnowledgeVersionSchema),
});
export const KnowledgeListSchema = z.object({ items: z.array(KnowledgeItemSchema) });
export const KnowledgeSaveSchema = z.object({
  revision: z.number().int().nonnegative(),
  content: KnowledgeContentSchema,
});
export const KnowledgeActivateSchema = z.object({
  revision: z.number().int().nonnegative(),
  versionId: z.uuid().nullable(),
});
export const KnowledgeRetrievalSchema = z.object({
  actionType: z.string(),
  day: z.number(),
  candidates: z.array(z.object({ id: z.string(), versionId: z.string(), similarity: z.number() })),
  selected: z.array(KnowledgeSnapshotSchema),
});
export const KnowledgeCallInputSchema = z.object({
  callId: z.string(),
  step: z.string(),
  dispatched: z.boolean(),
  knowledge: z.array(KnowledgeSnapshotSchema),
});
export const KnowledgeCallsSchema = z.object({
  calls: z.array(
    z.object({
      callId: z.string().nullable(),
      model: z.string(),
      status: z.string().nullable(),
      attempts: z.array(
        z.object({
          attemptNo: z.number(),
          status: z.string(),
          dispatched: z.boolean().nullable(),
          usage: z.record(z.string(), z.unknown()).nullable(),
        }),
      ),
    }),
  ),
});
export type KnowledgeContent = z.infer<typeof KnowledgeContentSchema>;
export type KnowledgeSnapshot = z.infer<typeof KnowledgeSnapshotSchema>;
export type KnowledgeVersion = z.infer<typeof KnowledgeVersionSchema>;
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;
export type KnowledgeRetrieval = z.infer<typeof KnowledgeRetrievalSchema>;
export type KnowledgeCallInput = z.infer<typeof KnowledgeCallInputSchema>;
export type KnowledgeCalls = z.infer<typeof KnowledgeCallsSchema>;
