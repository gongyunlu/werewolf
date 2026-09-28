import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { KnowledgeOrganizeSchema } from '@werewolf/shared';
import { ALL_BOARDS, type BoardId } from '../boards/boards';
import { loadEnv } from '../config/env';
import { modelRuntimeOf, promptSourceOf } from '../llm/from-env';
import { endpointOf } from '../llm/model-capability';
import {
  ModelCallError,
  type ModelAccess,
  type ModelPort,
  type ModelResponse,
} from '../llm/model-port';
import type { PromptSource } from '../llm/prompt-template';
import { recordingModelPort } from '../llm/recording-model-port';
import { gameSkills } from '../skills/game-skills';
import { KnowledgeConflictError } from '../store/knowledge';
import type { CaptureRecord, CaptureState, OrganizationState } from '../store/knowledge-imports';
import type { GameStores } from '../store/stores';
import { parseStructured } from '../turn/graph';
import {
  importPrompts,
  importRequest,
  KnowledgeProposalsSchema,
  resolveProposals,
} from './import-prompt';
import { fetchWebPage } from './web-source';

export const importEndpointKey = (access: Pick<ModelAccess, 'baseUrl'>) =>
  createHash('sha256').update(endpointOf(access.baseUrl)).digest('hex');
export async function captureKnowledgePage(
  stores: GameStores,
  id: string,
  fetchPage = fetchWebPage,
) {
  let row = await stores.knowledgeImports.find(id);
  if (!row) throw new Error('采集任务不存在');
  if (row.state.snapshot) return;
  row = await stores.knowledgeImports.save(row, {
    ...row.state,
    status: 'fetching',
    failure: null,
  });
  try {
    const [snapshot, previous] = await Promise.all([
      fetchPage(row.url),
      stores.knowledgeImports.previous(row),
    ]);
    await stores.knowledgeImports.save(row, {
      ...row.state,
      snapshot,
      previousId: previous?.id ?? null,
      status: snapshot.hash === previous?.state.snapshot?.hash ? 'unchanged' : 'ready',
    });
  } catch (error) {
    if (error instanceof KnowledgeConflictError) throw error;
    await stores.knowledgeImports.save(row, {
      ...row.state,
      status: 'failed',
      failure: error instanceof Error ? error.message : '网页采集失败',
    });
    throw error;
  }
}
export async function prepareOrganization(
  stores: GameStores,
  row: CaptureRecord,
  selection: z.infer<typeof KnowledgeOrganizeSchema>,
  runtime: { access: ModelAccess; promptSource: PromptSource },
) {
  if (row.revision !== selection.revision)
    throw new KnowledgeConflictError('采集记录已变化，请刷新');
  if (!row.state.snapshot || !['ready', 'unchanged'].includes(row.state.status))
    throw new KnowledgeConflictError('请先完成网页采集');
  const old = row.state.organization;
  if (old?.status === 'ready') return row;
  if (old?.status === 'unknown' || old?.attempts.at(-1)?.status === 'pending')
    throw new KnowledgeConflictError('上次整理请求结果未知，不能重发');
  if (old) return row;
  if (
    selection.boardIds.some((id) => !(id in ALL_BOARDS)) ||
    new Set(selection.boardIds).size !== selection.boardIds.length
  )
    throw new KnowledgeConflictError('请选择有效且不重复的板子');
  const paragraphs = row.state.snapshot.paragraphs.filter((p) =>
    selection.paragraphIds.includes(p.id),
  );
  if (
    paragraphs.length !== selection.paragraphIds.length ||
    paragraphs.reduce((sum, p) => sum + p.text.length, 0) > 12_000
  )
    throw new KnowledgeConflictError('请选择有效段落，正文总长度不能超过 12000 字');
  const items = await stores.knowledge.list();
  const targets = selection.targetIds.map((id) => {
    const item = items.find((i) => i.id === id);
    const content = item?.versions.at(-1)?.content;
    if (
      !item ||
      !content ||
      !content.sources.some(
        (s) =>
          s.sourceId === row.sourceId || s.url === row.url || s.url === row.state.snapshot!.url,
      )
    )
      throw new KnowledgeConflictError('更新目标必须明确关联本网页来源');
    return { id, revision: item.revision, content };
  });
  if (new Set(selection.targetIds).size !== targets.length)
    throw new KnowledgeConflictError('更新目标不能重复');
  const organization: OrganizationState = {
    status: 'queued',
    failure: null,
    reason: null,
    attempts: [],
    input: {
      boardIds: selection.boardIds,
      paragraphIds: selection.paragraphIds,
      targets,
      model: runtime.access.model,
      endpointKey: importEndpointKey(runtime.access),
      prompts: await importPrompts(runtime.promptSource),
      rules: selection.boardIds.map((id) => ({
        id,
        text: gameSkills(id as BoardId).ruleset.content,
      })),
    },
  };
  return stores.knowledgeImports.save(row, { ...row.state, organization });
}

export async function organizeKnowledgePage(
  stores: GameStores,
  id: string,
  provided?: { port: ModelPort; access: ModelAccess },
) {
  let row = await stores.knowledgeImports.find(id);
  if (!row?.state.organization) throw new Error('请先发起整理任务');
  if (row.state.organization.status === 'ready') return;
  if (row.state.organization.attempts.at(-1)?.status === 'pending')
    throw new KnowledgeConflictError('上次整理请求结果未知，不能重发');
  const save = async (organization: OrganizationState, patch: Partial<CaptureState> = {}) => {
    row = await stores.knowledgeImports.save(row!, { ...row!.state, ...patch, organization });
  };
  try {
    let complete: ModelResponse['completeObservation'];
    let organization = row.state.organization;
    let attempt = organization.attempts.at(-1);
    if (!attempt || ['failed', 'invalid'].includes(attempt.status)) {
      if (organization.attempts.length >= 3)
        throw new Error('已尝试三次整理，请核查调用记录与原文');
      const runtime = provided ?? modelRuntimeOf({ ...loadEnv(), MODEL_MAX_ATTEMPTS: 1 });
      if (
        runtime.access.model !== organization.input.model ||
        importEndpointKey(runtime.access) !== organization.input.endpointKey
      )
        throw new Error('整理接入或型号已改变，不能在原任务中混用');
      attempt = { callId: randomUUID(), status: 'pending' };
      await save({
        ...organization,
        status: 'running',
        failure: null,
        attempts: [...organization.attempts, attempt],
      });
      organization = row.state.organization!;
      const scope = { gameId: null, actionKey: null, knowledgeCaptureId: id };
      const port = recordingModelPort(
        runtime.port,
        (asked) => stores.asked.append(null, { ...asked, ...scope }),
        scope,
      );
      let received: ModelResponse | undefined;
      let failure: unknown;
      const started = performance.now();
      try {
        received = await port.generate(importRequest(row), runtime.access, {
          identity: {
            callId: attempt.callId,
            executionId: id,
            step: 'knowledge_organize',
            formatAttempt: organization.attempts.length,
          },
          onResponse: (response) => {
            received = response;
          },
        });
      } catch (error) {
        failure = error;
      }
      if (!received) {
        if (failure instanceof ModelCallError) {
          await save({
            ...organization,
            attempts: [...organization.attempts.slice(0, -1), { ...attempt, status: 'failed' }],
          });
        }
        throw failure ?? new Error('没有收到模型答复');
      }
      complete = received.completeObservation;
      attempt = {
        ...attempt,
        status: 'responded',
        durationMs: performance.now() - started,
        response: {
          content: received.content,
          toolCall: received.toolCall,
          reasoning: received.reasoning,
        },
      };
      await save({ ...organization, attempts: [...organization.attempts.slice(0, -1), attempt] });
    }
    organization = row.state.organization!;
    let candidates;
    let reason;
    try {
      if (!attempt.response?.toolCall) throw new Error('模型没有通过工具返回草稿');
      const result = parseStructured(
        attempt.response.toolCall.arguments,
        KnowledgeProposalsSchema,
        '网页攻略',
      );
      candidates = resolveProposals(row, result);
      reason = result.reason;
    } catch (error) {
      if (complete) await complete('invalid_output');
      else
        await stores.asked.finishCall(attempt.callId, {
          status: 'invalid_output',
          failureCode: 'invalid_output',
          durationMs: attempt.durationMs ?? 0,
        });
      await save({
        ...organization,
        attempts: [...organization.attempts.slice(0, -1), { ...attempt, status: 'invalid' }],
      });
      throw error;
    }
    if (complete) await complete('accepted');
    else
      await stores.asked.finishCall(attempt.callId, {
        status: 'accepted',
        failureCode: null,
        durationMs: attempt.durationMs ?? 0,
      });
    await save(
      {
        ...organization,
        status: 'ready',
        failure: null,
        reason,
        attempts: [...organization.attempts.slice(0, -1), { ...attempt, status: 'accepted' }],
      },
      { candidates },
    );
  } catch (error) {
    if (error instanceof KnowledgeConflictError) throw error;
    const organization = row.state.organization!;
    const unknown = organization.attempts.at(-1)?.status === 'pending';
    await save({
      ...organization,
      status: unknown ? 'unknown' : 'failed',
      failure: unknown
        ? '整理请求结果未知，已停止重发，请核查调用记录'
        : error instanceof Error
          ? error.message
          : '整理失败，可查看记录后继续',
    });
    throw error;
  }
}

export function organizationRuntime() {
  const env = loadEnv();
  return {
    ...modelRuntimeOf({ ...env, MODEL_MAX_ATTEMPTS: 1 }),
    promptSource: promptSourceOf(env),
  };
}
