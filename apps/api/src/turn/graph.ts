import { END, ReducedValue, START, StateGraph, StateSchema } from '@langchain/langgraph';
import { z } from 'zod';
import { actionKey } from '../core/identity';
import type { ModelAccess, ModelPort } from '../llm/model-port';
import { ModelCallError } from '../llm/model-port';
import { parseJsonOutput } from '../llm/parse-json-output';
import { ACTION_PRESETS } from './presets';
import {
  CRITIQUE_SCHEMA,
  renderCritique,
  renderGenerate,
  renderRevise,
  TURN_PROMPT_NAMES_ALL,
  type RenderedPrompt,
  type RenderedTurn,
} from './prompt';
import { decisionSchemaJson, type ActionRequest, type TurnRuntime } from './request';
import { decisionInputHash, type Critique, type DecisionSnapshot } from './snapshot';

/** 一次行动交出去的东西。 */
export interface TurnOutcome {
  /** 校验过的结果；发言就是草稿原文。 */
  decision: unknown;
  /** 这次决定是怎么来的。 */
  snapshot: DecisionSnapshot;
}

const TurnState = new StateSchema({
  request: z.custom<ActionRequest>(),
  draft: z.string().default(''),
  decision: z.custom<unknown>().default(() => null),
  // 通道名叫 verdict 而不是 critique：通道名不能和节点名撞车，那边已经占了 critique。
  verdict: z.custom<Critique | null>().default(() => null),
  prompts: new ReducedValue(
    z.array(z.custom<RenderedPrompt>()).default(() => []),
    {
      reducer: (current, update) => current.concat(update),
    },
  ),
  outcome: z.custom<TurnOutcome | null>().default(() => null),
});

type TurnStateValue = typeof TurnState.State;

/** 端口与接入身份从 config 走，不进图状态——进了状态就会跟着检查点落库。 */
const RUNTIME_KEY = 'turnRuntime';

interface TurnConfig {
  configurable?: Record<string, unknown>;
}

/**
 * 取出这次行动的运行环境。
 * 取不到就是有人绕过 runActionGraph 直接 invoke 了这张图，那是误用，当场炸。
 *
 * @param config 图的运行配置，端口与接入身份都从这个口子递进来
 * @returns 模型端口、接入身份，以及整局冻好的那六条提示词
 */
function turnRuntime(config: TurnConfig | undefined): TurnRuntime {
  const runtime = config?.configurable?.[RUNTIME_KEY] as TurnRuntime | undefined;
  if (!runtime) throw new Error('行动图缺少模型端口');
  return runtime;
}

/**
 * 问模型一次，拿回它的原文。
 * 只递两段正文过去：模板的版本与来源是给自己记账的，不进模型那一侧。
 *
 * @param port 模型端口
 * @param access 接入身份，模型端点与能力声明
 * @param turn 渲染好的这一对提示词
 * @returns 模型输出的原文，这里不解析
 */
async function ask(port: ModelPort, access: ModelAccess, turn: RenderedTurn): Promise<string> {
  const response = await port.generate(
    { system: turn.system.text, prompt: turn.user.text },
    access,
  );
  return response.content;
}

/**
 * 记下这次问出去的两段。
 * 系统在前、用户在后，与提示词里的顺序一致。
 *
 * @param turn 渲染好的这一对提示词
 * @returns 这次用到的两段，按顺序
 */
function used(turn: RenderedTurn): RenderedPrompt[] {
  return [turn.system, turn.user];
}

/**
 * 解析模型输出，再按 schema 校验一遍。
 * 两种失败归同一个错码：对调用方来说「不是 JSON」和「是 JSON 但字段不对」是一件事——模型没照要求交。
 *
 * @param content 模型输出的原文
 * @param schema 要求的形状
 * @param access 接入身份，由它的能力声明决定要不要剥代码围栏
 * @param what 出错信息里指代这份输出的说法，比如「3 号这次的决定」
 * @returns 校验过的结果
 */
function parseStructured<S extends z.ZodType>(
  content: string,
  schema: S,
  access: ModelAccess,
  what: string,
): z.infer<S> {
  let raw: unknown;
  try {
    raw = parseJsonOutput(content, access.capability.allowCodeFence);
  } catch (error) {
    throw new ModelCallError('invalid_output', `${what}不是合法 JSON`, { cause: error });
  }

  const checked = schema.safeParse(raw);
  if (!checked.success) {
    throw new ModelCallError('invalid_output', `${what}不符合要求：${checked.error.message}`, {
      cause: checked.error,
    });
  }
  return checked.data;
}

/**
 * 把草稿变成这次的决定。
 * 没有 schema 就是发言，原文即结果，不解析也不包装。
 *
 * @param request 这次行动，由它带出决定该有的形状
 * @param draft 模型交上来的原文
 * @param access 接入身份
 * @returns 校验过的结果；发言就是原文
 */
function parseDecision(request: ActionRequest, draft: string, access: ModelAccess): unknown {
  if (!request.schema) return draft;
  return parseStructured(draft, request.schema, access, `${request.actorId} 这次的决定`);
}

/**
 * 问模型要一版草稿，当场解析。
 * 解析不过当场抛，不带着不合要求的草稿往下走：留到质疑那里再发现，白花一次调用。
 *
 * @param state 图状态，这里只读行动请求
 * @param config 图的运行配置
 * @returns 草稿、解析后的决定，以及这次用到的两段提示词
 */
async function generateNode(
  state: TurnStateValue,
  config: TurnConfig,
): Promise<Partial<TurnStateValue>> {
  const { port, access, prompts } = turnRuntime(config);
  const turn = renderGenerate(
    prompts,
    state.request.context,
    decisionSchemaJson(state.request.schema),
  );
  const draft = await ask(port, access, turn);

  return {
    draft,
    decision: parseDecision(state.request, draft, access),
    prompts: used(turn),
  };
}

/**
 * 让别人来质疑这版草稿。
 * 校验的是质疑自己那套固定形状，不是 request.schema——它只判「行不行」，自己不交决定。
 *
 * @param state 图状态，这里读行动请求与草稿
 * @param config 图的运行配置
 * @returns 质疑的结论，以及这次用到的两段提示词
 */
async function critiqueNode(
  state: TurnStateValue,
  config: TurnConfig,
): Promise<Partial<TurnStateValue>> {
  const { port, access, prompts } = turnRuntime(config);
  const schemaJson = decisionSchemaJson(state.request.schema);
  const turn = renderCritique(prompts, state.request.context, state.draft, schemaJson);
  const content = await ask(port, access, turn);

  return {
    verdict: parseStructured(content, CRITIQUE_SCHEMA, access, '质疑的结论'),
    prompts: used(turn),
  };
}

/**
 * 按质疑意见重做一版。
 * 结果与生成走同一条解析，改完的那版才是最终决定。
 *
 * @param state 图状态，这里读行动请求、上一版草稿与质疑结论
 * @param config 图的运行配置
 * @returns 新草稿、解析后的决定，以及这次用到的两段提示词
 */
async function reviseNode(
  state: TurnStateValue,
  config: TurnConfig,
): Promise<Partial<TurnStateValue>> {
  if (!state.verdict) throw new Error('走到修订却没有质疑结论');

  const { port, access, prompts } = turnRuntime(config);
  const schemaJson = decisionSchemaJson(state.request.schema);
  const turn = renderRevise(
    prompts,
    state.request.context,
    state.draft,
    state.verdict.issues,
    schemaJson,
  );
  const draft = await ask(port, access, turn);

  return {
    draft,
    decision: parseDecision(state.request, draft, access),
    prompts: used(turn),
  };
}

/**
 * 收口，把结果和它的来历一起打包。
 * 快照的 prompts 只记这次真渲染过的那几条，哈希里那份是整局六条全量：
 * 复算要答的是「这局用的是哪六条」，与这次走没走到质疑无关。
 *
 * @param state 图状态，这里读行动请求、草稿、决定与用过的提示词
 * @param config 图的运行配置，整局冻好的提示词从它取
 * @returns 这次行动的最终产物
 */
function finalizeNode(state: TurnStateValue, config: TurnConfig): Partial<TurnStateValue> {
  const { access, prompts: frozen } = turnRuntime(config);
  const { request } = state;
  const schemaJson = decisionSchemaJson(request.schema);
  const key = actionKey(request.scope, request.actionType, request.actorId, request.actionOrdinal);

  return {
    outcome: {
      decision: state.decision,
      snapshot: {
        actionKey: key,
        actionType: request.actionType,
        actorId: request.actorId,
        actionOrdinal: request.actionOrdinal,
        preset: request.preset,
        capability: access.capability,
        context: request.context,
        schema: schemaJson,
        prompts: state.prompts,
        inputHash: decisionInputHash({
          actionKey: key,
          actionType: request.actionType,
          actionOrdinal: request.actionOrdinal,
          preset: request.preset,
          capability: access.capability,
          context: request.context,
          schema: schemaJson,
          // 整局冻的那六条全进哈希，包括这次没走到的：输入变没变与该走哪条路无关。
          prompts: TURN_PROMPT_NAMES_ALL.map((name) => frozen[name]),
        }),
        draft: state.draft,
        critique: state.verdict,
        decision: state.decision,
      },
    },
  };
}

/**
 * 生成之后问不问质疑。
 *
 * @param state 图状态，这里只读行动档位
 * @returns 下一个节点：要质疑就走 critique，不要就直接收口
 */
function needsCritique(state: TurnStateValue): 'critique' | 'finalize' {
  return ACTION_PRESETS[state.request.preset].critique ? 'critique' : 'finalize';
}

/**
 * 质疑过了就直接交，没过才修订。
 *
 * @param state 图状态，这里只读质疑结论
 * @returns 下一个节点
 */
function afterCritique(state: TurnStateValue): 'revise' | 'finalize' {
  return state.verdict?.accept ? 'finalize' : 'revise';
}

/** 行动图：先生成，按档位决定要不要质疑，质疑没过才修订，修订完直接收口。 */
const actionGraph = new StateGraph(TurnState)
  .addNode('generate', generateNode)
  .addNode('critique', critiqueNode)
  .addNode('revise', reviseNode)
  .addNode('finalize', finalizeNode)
  .addEdge(START, 'generate')
  .addConditionalEdges('generate', needsCritique, ['critique', 'finalize'])
  .addConditionalEdges('critique', afterCritique, ['revise', 'finalize'])
  .addEdge('revise', 'finalize')
  .addEdge('finalize', END)
  .compile();

/**
 * 执行一次行动图，返回最终结果与快照。
 * 这张图只跑一次，跑完就结束了。
 * 质疑是独立的，不会把不合要求的草稿往下传：留到质疑那里再发现，白花一次调用。
 * 修订是独立的，不会再回头质疑：改完的那版才是最终决定。
 *
 * @param runtime 模型端口与接入身份
 * @param request 行动请求，包含行动类型、玩家身份、行动档位、行动序号、局面与任务、输出形状等信息
 * @returns 最终结果与快照，包含校验过的结果、快照信息等
 */
export async function runActionGraph(
  runtime: TurnRuntime,
  request: ActionRequest,
): Promise<TurnOutcome> {
  const settled = await actionGraph.invoke(
    { request },
    { configurable: { [RUNTIME_KEY]: runtime } },
  );
  if (!settled.outcome) throw new Error('行动图跑完了却没有结果');
  return settled.outcome;
}
