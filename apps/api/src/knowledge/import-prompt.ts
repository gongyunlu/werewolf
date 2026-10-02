import { IMPORT_PROMPTS, loadPrompt } from '../prompts/catalog';
import { z } from 'zod';
import { KnowledgeContentSchema, type KnowledgeCandidate } from '@werewolf/shared';
import { randomUUID } from 'node:crypto';
import { renderTemplate, type PromptSource } from '../prompts/template';
import { toolOf } from '../llm/structured-output';
import type { CaptureRecord } from '../store/knowledge-imports';
import { validateKnowledgeContent } from './content-validation';

const fields = KnowledgeContentSchema.shape;
export const KnowledgeProposalsSchema = z.object({
  reason: z.string().min(1).max(600),
  proposals: z
    .array(
      z.object({
        targetId: z.uuid().nullable(),
        content: z.object({
          kind: fields.kind,
          title: fields.title,
          body: fields.body,
          conditions: fields.conditions,
          adaptation: fields.adaptation,
          rulesBasis: fields.rulesBasis,
          boardIds: fields.boardIds,
          roles: fields.roles,
          actionTypes: fields.actionTypes,
          firstDayOnly: fields.firstDayOnly,
          minDay: fields.minDay,
        }),
        paragraphIds: z
          .array(z.string().regex(/^P\d+$/))
          .min(1)
          .max(10),
      }),
    )
    .max(5),
});
export async function importPrompts(source: PromptSource) {
  return Promise.all(Object.values(IMPORT_PROMPTS).map((name) => loadPrompt(source, name)));
}
export function importRequest(row: CaptureRecord) {
  const input = row.state.organization!.input;
  const snapshot = row.state.snapshot!;
  const variables = {
    rules: JSON.stringify(input.rules),
    targets: JSON.stringify({
      actionTypes: fields.actionTypes.element.options,
      targets: input.targets,
    }),
    source: JSON.stringify({
      ...snapshot,
      paragraphs: snapshot.paragraphs.filter((p) => input.paragraphIds.includes(p.id)),
    }),
  };
  return {
    system: renderTemplate(input.prompts[0]!, variables),
    prompt: renderTemplate(input.prompts[1]!, variables),
    prompts: input.prompts.map(({ name, version, source }) => ({ name, version, source })),
    primaryPrompt: IMPORT_PROMPTS.user,
    tool: toolOf(KnowledgeProposalsSchema, '提交有原文段落引用的攻略草稿或零条结果'),
  };
}
export function resolveProposals(
  row: CaptureRecord,
  result: z.infer<typeof KnowledgeProposalsSchema>,
): KnowledgeCandidate[] {
  const input = row.state.organization!.input;
  const snapshot = row.state.snapshot!;
  const seen = new Set<string>();
  return result.proposals.map((proposal) => {
    const target = proposal.targetId ? input.targets.find((t) => t.id === proposal.targetId) : null;
    if (proposal.targetId && (!target || seen.has(proposal.targetId)))
      throw new Error('更新目标不存在或被重复引用');
    if (target) seen.add(target.id);
    if (proposal.content.boardIds.some((id) => !input.boardIds.includes(id)))
      throw new Error('候选使用了未选择的板子');
    if (proposal.paragraphIds.some((id) => !input.paragraphIds.includes(id)))
      throw new Error('候选引用了未提供的原文段落');
    const content = KnowledgeContentSchema.parse({
      ...proposal.content,
      sources: [
        {
          title: snapshot.title,
          url: snapshot.url,
          publisher: snapshot.publisher,
          author: snapshot.author,
          locator: proposal.paragraphIds.join('、'),
          publishedOn: snapshot.publishedOn,
          checkedOn: new Date().toISOString().slice(0, 10),
          captureId: row.id,
          sourceId: row.sourceId,
          paragraphIds: proposal.paragraphIds,
        },
        ...(target?.content.sources.filter(
          (s) => s.sourceId !== row.sourceId && s.url !== row.url && s.url !== snapshot.url,
        ) ?? []),
      ],
    });
    validateKnowledgeContent(content);
    return {
      id: randomUUID(),
      itemId: target?.id ?? randomUUID(),
      expectedRevision: target?.revision ?? 0,
      before: target?.content ?? null,
      content,
      status: 'pending',
      versionId: null,
    };
  });
}
