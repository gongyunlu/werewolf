import {
  END,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { randomUUID } from 'node:crypto';
import type { ActionStep } from '@werewolf/shared';
import { z } from 'zod';
import type { ModelAccess, ModelPort, ModelTool, StreamDelta } from '../llm/model-port';
import { InvalidOutputError } from '../llm/model-port';
import type { ModelResponse } from '../llm/model-port';
import type { CallIdentity } from '../llm/observation';
import { toolOf } from './decisions';
import { ACTION_PRESETS } from './presets';
import {
  CRITIQUE_SCHEMA,
  renderCritique,
  renderGenerate,
  renderRevise,
  type RenderedPrompt,
  type RenderedTurn,
} from './prompt';
import { actionKeyOf, decisionSchemaJson, type ActionRequest, type TurnRuntime } from './request';
import type { Critique, DecisionSnapshot } from './snapshot';

/** 一次行动交出去的东西。 */
export interface TurnOutcome {
  /** 校验过的结果；发言就是草稿原文。 */
  decision: unknown;
  /** 这次决定是怎么来的。 */
  snapshot: DecisionSnapshot;
}

const TurnState = new StateSchema({
  sourceCallId: z.string().nullable().default(null),
  draft: z.string().default(''),
  decision: z.custom<unknown>().default(() => null),
  // 通道名叫 verdict 而不是 critique：通道名不能和节点名撞车，那边已经占了 critique。
  verdict: z.custom<Critique | null>().default(() => null),
  // 最终那版决定之前模型自己那段推理。生成时写下、修订覆盖它；质疑那一问不写。
  reasoning: z.string().nullable().default(null),
  critiqueReasoning: z.string().nullable().default(null),
  thinkingMs: z.number().nullable().default(null),
  totalThinkingMs: new ReducedValue(z.number().nullable().default(null), {
    reducer: (current, update) => (update === null ? current : (current ?? 0) + update),
  }),
  prompts: new ReducedValue(
    z.array(z.custom<RenderedPrompt>()).default(() => []),
    {
      reducer: (current, update) => current.concat(update),
    },
  ),
  outcome: z.custom<TurnOutcome | null>().default(() => null),
  // 这次行动里模型一共交歪了几回。生成、质疑、修订各加各的，合起来是这一趟的总数——
  // 它只进快照，不参与判定；为 0 就是这一趟每一问都一次交对。
  retries: new ReducedValue(z.number().default(0), {
    reducer: (current, update) => current + update,
  }),
});

type TurnStateValue = typeof TurnState.State;

// 模型接入与校验器只存在于本次调用，不写入检查点。
const TurnContext = z.object({
  runtime: z.custom<TurnRuntime>(),
  request: z.custom<ActionRequest>(),
});
type TurnConfig = LangGraphRunnableConfig<z.infer<typeof TurnContext>>;

/** 往外推给观战那一头的一片：这是第几趟问、哪条通道、到目前写成了什么。 */
export interface StreamChunk {
  thinkingMs?: number;
  callId: string;
  channel: StreamDelta['channel'];
  /** 这一路到目前的全文，不是增量。 */
  text: string;
}

/**
 * 把这一问的身份补到往外推的那片上。
 * callId 由 ask 铸，一次模型调用一个：模型答歪了会带着话说重问，那是新的一趟，
 * 观战那头的卡片跟着重开，不会把两趟的字接在一起。
 *
 * @param request 这次行动，行动键、座位与类型都从它取
 * @param step 走到图里哪一步，观战那头按它显示「正在生成」还是「正在重做」
 * @param preview 观战那一头的口子；没人看就是 undefined，返回 undefined 走一次收完那条路
 */
function previewFor(
  request: ActionRequest,
  step: string,
  preview: TurnRuntime['preview'],
): ((chunk: StreamChunk) => void) | undefined {
  if (!preview) return undefined;

  return (chunk) => {
    preview({
      actionKey: actionKeyOf(request),
      day: request.context.day,
      seatNo: request.context.actor.seatNo,
      actionType: request.actionType,
      step,
      ...chunk,
    });
  };
}

/** 一问的答复。答案与推理是分开的两段，各有各的空法：答案可能在工具那一头，推理可能端点没给。 */
export interface Answer {
  callId?: string;
  completeObservation?: ModelResponse['completeObservation'];
  thinkingMs?: number;
  content: string;
  reasoning: string | null;
  /** 给了工具却只写了一段话，没走工具交。不给工具的那几问（发言）恒为 false。 */
  noToolCall: boolean;
}

/**
 * 问模型一次，拿回它交的答案与它自己那段推理。
 * 只递两段正文过去：模板的版本与来源是给自己记账的，不进模型那一侧。
 *
 * 两段分开接：答案那一头要走校验，推理那一头不校验，原样留着给人看。
 *
 * @param port 模型端口
 * @param access 接入身份，模型端点与能力声明
 * @param turn 渲染好的这一对提示词
 * @param tool 要它走哪个工具交；不给就是让它写一段话
 * @param stream 边写边往外推的口子；不给就一次收完
 * @returns 这一问的答复：答案原文（走工具时取参数那一头）、它写答案之前的推理，以及有没有走工具交
 */
export async function ask(
  port: ModelPort,
  access: ModelAccess,
  turn: RenderedTurn,
  tool?: ModelTool,
  stream?: (chunk: StreamChunk) => void,
  identity?: Omit<CallIdentity, 'callId'>,
): Promise<Answer> {
  const callId = randomUUID();
  const response = await port.generate(
    { system: turn.system.text, prompt: turn.user.text, tool },
    access,
    // 走工具的那几问只会收到思考：正文那一头本来就是空的。
    {
      identity: {
        executionId: randomUUID(),
        step: 'summary',
        formatAttempt: 1,
        ...identity,
        callId,
      },
      ...(stream ? { onDelta: (delta: StreamDelta) => stream({ callId, ...delta }) } : {}),
    },
  );
  // 走工具时答案在参数那一头、正文是空的；没给工具时才是正文。
  return {
    callId,
    completeObservation: response.completeObservation,
    content: response.toolCall?.arguments ?? response.content,
    reasoning: response.reasoning,
    ...(response.thinkingMs !== undefined ? { thinkingMs: response.thinkingMs } : {}),
    // 给了工具却只写了一段话：这一问它根本没交值。按 JSON 解析那一头报出来的是
    // 「整串不是合法 JSON」，指错了地方——它写的本来就不是 JSON，是一段解释。
    // 正文一律当解释看：正文里就算摆着一份合规的 JSON，也不算它交了（要交就走工具）。
    noToolCall: tool !== undefined && response.toolCall === null,
  };
}

/** 这次行动交给模型的工具。没有形状的那几问（发言）让它写一段话，不走工具。 */
function toolFor(request: ActionRequest): ModelTool | undefined {
  return request.schema ? toolOf(request.schema, request.context.task) : undefined;
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
 * 解析模型输出的那一串，再按 schema 校验一遍。
 * 三种失败归同一个错码：对调用方来说「不是 JSON」「壳没裹对」「值不对」是一件事——模型没照要求交。
 * 分成三句诊断是为了给模型看：它要照着那句话改，说成「不符合要求」等于没说。
 *
 * 不剥代码围栏、不抽片段：这几问都是走工具交的，拿到手的就是工具参数那一串 JSON。
 *
 * @param content 模型交上来的那一串
 * @param schema 要求的形状
 * @param what 出错信息里指代这份输出的说法，比如「3 号这次的决定」
 * @returns 校验过的结果
 */
export function parseStructured<S extends z.ZodType>(
  content: string,
  schema: S,
  what: string,
): z.infer<S> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new InvalidOutputError(
      `${what}不是合法 JSON；交上来的是 ${content}`,
      '整串不是合法 JSON',
      { cause: error },
    );
  }

  // 交上来的得是裹着壳的那个对象（顶层得是 object 才收，见 decisions 的 toolOf），
  // 那一层不是这次要交的东西，校验前先剥掉。壳本身没交对也算不合规——
  // 整串就是 null 的话，取 .value 抛的是裸 TypeError，上面那层认不出来，会跳过重问直接停掉整局。
  // 忘了裹壳（顶层是对象但没有 value）也算壳没交对：归到壳那一类，它会去补壳而不是改值。
  if (typeof parsed !== 'object' || parsed === null || !('value' in parsed)) {
    throw new InvalidOutputError(
      `${what}不是裹着壳的对象；交上来的是 ${content}`,
      '没裹在规定的那个对象里',
    );
  }
  const raw = (parsed as { value: unknown }).value;

  const checked = schema.safeParse(raw);
  if (!checked.success) {
    // 交上来的原物一并写进错里：只报「不符合要求」的话，跑完一局回来查不出它到底答了什么。
    throw new InvalidOutputError(
      `${what}不符合要求：${checked.error.message}；交上来的是 ${JSON.stringify(raw)}`,
      '交的那个值不合这次要求的形状',
      { cause: checked.error },
    );
  }
  return checked.data;
}

/** 答得不合规时再问几次。 */
const INVALID_OUTPUT_RETRIES = 2;

/**
 * 问一次并当场解析；模型答得不合规就带着上一次的失败原因再问。
 *
 * 再问的不能是同一份题面：模型上一回就是看着那份答错的，一字不改地再发一遍，它没有理由换个答案
 * ——实测那次连问三次交回来的是同一个座位号。附上去的是「你交的是什么、这次要的是什么」。
 *
 * 一局要问几百次，一次答歪就让整局停下来，代价比多花两次调用大得多；三次都不行才抛。
 *
 * 这一层跟端口那一层的重试不是一回事：端口重发的是「这次没拿到」，它看不见解析。
 * 问一次也放在 try 外面，正是这个分工：端口自己的失败，上面那一层已经重试过了，
 * 再裹进来重问就是两层的次数相乘。
 *
 * @param askOnce 问一次，拿回模型的原文与它的推理；带一条上一次的失败说明，第一次为 null
 * @param parse 把原文解析成要的形状，不合规当场抛
 * @param noteOf 由交上来的原文与它错在哪一类，生成那条失败说明
 * @returns 原文、它的推理、解析后的结果，以及为这次解析重问了几回
 */
export async function askParsed<T>(
  askOnce: (note: string | null, formatAttempt: number) => Promise<Answer>,
  parse: (content: string) => T,
  noteOf: (raw: string, diagnosis: string) => string,
): Promise<{
  callId?: string;
  content: string;
  reasoning: string | null;
  parsed: T;
  retries: number;
  thinkingMs?: number;
}> {
  let note: string | null = null;
  let thinkingMs: number | undefined;

  for (let attempt = 0; ; attempt += 1) {
    const answer = await askOnce(note, attempt + 1);
    if (answer.thinkingMs !== undefined) thinkingMs = (thinkingMs ?? 0) + answer.thinkingMs;
    let parsed: T;
    try {
      // 给了工具却没走工具：它一个值都没交。落到下面按 JSON 解析去，报出来的是「不是合法
      // JSON」——那句话把它写的一段解释当成了没写好的 JSON，指错了地方，它照着重交还是交不上。
      if (answer.noToolCall) {
        throw new InvalidOutputError(
          `这一问给了工具，它没走工具交；写的是 ${answer.content}`,
          '没走工具交，只写了正文',
        );
      }
      // 重问过的话，交出的是最后那一版——被作废那几版的推理没有留的价值。
      parsed = parse(answer.content);
    } catch (error) {
      await answer.completeObservation?.(
        error instanceof InvalidOutputError ? 'invalid_output' : 'failed',
      );
      // 只认带诊断的那一个：拿不出「错在哪一类」，重问的题面就跟上一次一字不差，白问。
      if (!(error instanceof InvalidOutputError)) throw error;
      if (attempt >= INVALID_OUTPUT_RETRIES) throw error;
      note = noteOf(answer.content, error.diagnosis);
      continue;
    }
    // 存储失败不属于格式错误，不能因此再问一次模型。
    await answer.completeObservation?.('accepted');
    return {
      ...(answer.callId ? { callId: answer.callId } : {}),
      content: answer.content,
      reasoning: answer.reasoning,
      parsed,
      retries: attempt,
      ...(thinkingMs !== undefined ? { thinkingMs } : {}),
    };
  }
}

/**
 * 上一次没交成，附回题面的那条说明。
 *
 * 说清三件事：交上来的是什么、错在哪一类、这次能交什么。只写「不合要求」等于没给可纠正的依据，
 * 模型只能照着原样再掷一次。也不带校验器那句原文——那是英文的 zod 报错（code/path/values
 * 一整套），进题面只是把噪声递给模型，不告诉它该改成什么。
 *
 * 候选只按「目标」说，不说成整份取值域：投票、提刀、守护那几问合法的还有弃票与空过，
 * 警徽那一问还有「撕掉」，女巫还有「都不用」——说成「只能选这些」是把范围说小了。
 * 题面里那句本来也是「可以选的目标只有下面这些」。
 *
 * @param options 这次能选的座位；没有候选的那一问（质疑）给空数组
 * @param raw 上一次交上来的原文
 * @param diagnosis 错在哪一类，由解析那一头给出
 * @param explainInThinking 末句要不要点它去思考里说清改选的理由；只有要留思考的那几问给真
 * @returns 追加到题面末尾的那一行
 */
export function retryNote(
  options: readonly string[],
  raw: string,
  diagnosis: string,
  explainInThinking = false,
): string {
  const expected =
    options.length > 0
      ? `这次的目标只能从这些里选：${options.join('、')}`
      : '这次要按题里写明的形状交';
  const explain = explainInThinking
    ? '重交时在思考里说清上一次为什么不成立、这次为什么改选它。'
    : '';

  return `上一次交的「${raw}」不作数：${diagnosis}。${expected}。${explain}`;
}

/**
 * 把那条说明接在正文末尾，紧挨着「交上来」那句话。
 *
 * @param turn 渲染好的这一对提示词
 * @param note 上一次的失败说明
 * @returns 换了用户那一段的提示词对，系统那一段原样
 */
export function noted(turn: RenderedTurn, note: string): RenderedTurn {
  return { ...turn, user: { ...turn.user, text: `${turn.user.text}\n${note}` } };
}

/**
 * 把草稿变成这次的决定。
 * 没有 schema 就是发言，原文即结果，不解析也不包装。
 *
 * @param request 这次行动，由它带出决定该有的形状
 * @param draft 模型交上来的原文
 * @returns 校验过的结果；发言就是原文
 */
function parseDecision(request: ActionRequest, draft: string): unknown {
  if (!request.schema) return draft;
  return parseStructured(draft, request.schema, `${request.actorId} 这次的决定`);
}

/**
 * 问模型要一版草稿，当场解析。
 * 解析不过先重问几次，还是不行才抛：不带着不合要求的草稿往下走，留到质疑那里再发现是白花两次调用。
 *
 * @param state 图状态，这里只读行动请求
 * @param config 图的运行配置
 * @returns 草稿、解析后的决定，以及这次用到的两段提示词
 */
async function generateNode(
  state: TurnStateValue,
  config: TurnConfig,
): Promise<Partial<TurnStateValue>> {
  const identity = executionIdentity('generate', config);
  const { runtime, request } = config.context!;
  const { port, accessFor, promptSource, preview } = runtime;
  const access = accessFor(request.context.actor.seatNo);
  const turn = await renderGenerate(
    promptSource,
    request.context,
    decisionSchemaJson(request.schema),
  );
  const tool = toolFor(request);
  const stream = previewFor(request, 'generate', preview);
  const { content, reasoning, parsed, retries, thinkingMs, callId } = await askParsed(
    (note, formatAttempt) =>
      ask(port, access, note === null ? turn : noted(turn, note), tool, stream, {
        ...identity,
        formatAttempt,
      }),
    (draft) => parseDecision(request, draft),
    (raw, diagnosis) => retryNote(request.context.options, raw, diagnosis, true),
  );

  return {
    sourceCallId: callId ?? null,
    draft: content,
    decision: parsed,
    prompts: used(turn),
    retries,
    reasoning,
    thinkingMs: thinkingMs ?? null,
    totalThinkingMs: thinkingMs ?? null,
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
  const identity = executionIdentity('critique', config);
  const { runtime, request } = config.context!;
  const { port, accessFor, promptSource, preview } = runtime;
  const access = accessFor(request.context.actor.seatNo);
  // 形状给工具那一份，和草稿同一层；给内层 schema 的话，多出来的壳会被判成形式错误。
  const turn = await renderCritique(
    promptSource,
    request.context,
    state.draft,
    toolFor(request)?.parameters ?? null,
  );
  const stream = previewFor(request, 'critique', preview);
  const { parsed, retries, reasoning, thinkingMs } = await askParsed(
    (note, formatAttempt) =>
      ask(
        port,
        access,
        note === null ? turn : noted(turn, note),
        toolOf(CRITIQUE_SCHEMA, '这次质疑的结论'),
        stream,
        { ...identity, formatAttempt },
      ),
    (content) => parseStructured(content, CRITIQUE_SCHEMA, '质疑的结论'),
    // 质疑那一问没有候选，重试提示只说明格式问题。
    (raw, diagnosis) => retryNote([], raw, diagnosis),
  );

  return {
    verdict: parsed,
    prompts: used(turn),
    retries,
    critiqueReasoning: reasoning,
    thinkingMs: thinkingMs ?? null,
    totalThinkingMs: thinkingMs ?? null,
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
  const identity = executionIdentity('revise', config);
  if (!state.verdict) throw new Error('走到修订却没有质疑结论');

  const { runtime, request } = config.context!;
  const { port, accessFor, promptSource, preview } = runtime;
  const access = accessFor(request.context.actor.seatNo);
  const schemaJson = decisionSchemaJson(request.schema);
  const turn = await renderRevise(
    promptSource,
    request.context,
    state.draft,
    state.verdict.issues,
    schemaJson,
  );
  const tool = toolFor(request);
  const stream = previewFor(request, 'revise', preview);
  const { content, reasoning, parsed, retries, thinkingMs, callId } = await askParsed(
    (note, formatAttempt) =>
      ask(port, access, note === null ? turn : noted(turn, note), tool, stream, {
        ...identity,
        formatAttempt,
      }),
    (draft) => parseDecision(request, draft),
    (raw, diagnosis) => retryNote(request.context.options, raw, diagnosis, true),
  );

  return {
    sourceCallId: callId ?? null,
    draft: content,
    decision: parsed,
    prompts: used(turn),
    retries,
    reasoning,
    thinkingMs: thinkingMs ?? null,
    totalThinkingMs: thinkingMs ?? null,
  };
}

/**
 * 收口，把结果和它的来历一起打包。
 * 快照的 prompts 记的是这次真渲染过的那几条——哪条取到的是平台哪一版，全在那个数组里。
 *
 * @param state 图状态，这里读行动请求、草稿、决定与用过的提示词
 * @param config 图的运行配置，接入身份从它取
 * @returns 这次行动的最终产物
 */
function finalizeNode(state: TurnStateValue, config: TurnConfig): Partial<TurnStateValue> {
  const { runtime, request } = config.context!;
  const { accessFor } = runtime;
  // 快照上记的型号是这个人这一局用的那个，不是整局的默认型号。
  const access = accessFor(request.context.actor.seatNo);
  const schemaJson = decisionSchemaJson(request.schema);

  return {
    outcome: {
      decision: state.decision,
      snapshot: {
        sourceCallId: state.sourceCallId ?? null,
        actionKey: actionKeyOf(request),
        actionType: request.actionType,
        actorId: request.actorId,
        actionOrdinal: request.actionOrdinal,
        preset: request.preset,
        model: access.model,
        capability: access.capability,
        context: request.context,
        schema: schemaJson,
        prompts: state.prompts,
        draft: state.draft,
        critique: state.verdict,
        decision: state.decision,
        reasoning: state.reasoning,
        thinkingMs: state.totalThinkingMs,
        retries: state.retries,
      },
    },
  };
}

function executionIdentity(
  step: string,
  config: TurnConfig,
): Omit<CallIdentity, 'callId' | 'formatAttempt'> {
  return {
    step,
    executionId: randomUUID(),
    taskId: config.executionInfo?.taskId,
    checkpointId: config.executionInfo?.checkpointId,
  };
}

/**
 * 生成之后问不问质疑。
 *
 * @param state 图状态，这里什么都不读
 * @param config 图的运行配置，行动档位从它取
 * @returns 下一个节点：要质疑就走 critique，不要就直接收口
 */
function needsCritique(_state: TurnStateValue, config: TurnConfig): 'critique' | 'finalize' {
  return ACTION_PRESETS[config.context!.request.preset].critique ? 'critique' : 'finalize';
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
function buildActionGraph(saver?: BaseCheckpointSaver) {
  const builder = new StateGraph(TurnState, { context: TurnContext })
    .addNode('generate', generateNode)
    .addNode('critique', critiqueNode)
    .addNode('revise', reviseNode)
    .addNode('finalize', finalizeNode)
    .addEdge(START, 'generate')
    .addConditionalEdges('generate', needsCritique, ['critique', 'finalize'])
    .addConditionalEdges('critique', afterCritique, ['revise', 'finalize'])
    .addEdge('revise', 'finalize')
    .addEdge('finalize', END);

  return saver ? builder.compile({ checkpointer: saver }) : builder.compile();
}

/** 不带进度的图：编一次用到底。 */
const plainGraph = buildActionGraph();

/** 每种存法各编一张图：编译不便宜，而一局要跑几百次行动。 */
const graphsBySaver = new WeakMap<BaseCheckpointSaver, typeof plainGraph>();

function actionGraphOf(saver: BaseCheckpointSaver | undefined): typeof plainGraph {
  if (!saver) return plainGraph;
  const cached = graphsBySaver.get(saver) ?? buildActionGraph(saver);
  graphsBySaver.set(saver, cached);
  return cached;
}

/** 这一次行动接着上次跑还是从头跑。 */
export interface ActionGraphOptions {
  /** 存放执行进度的地方；不给就是跑完即弃。 */
  saver?: BaseCheckpointSaver;
  /** 上一跑断在半路、这一次接着跑完。 */
  resume?: boolean;
}

/**
 * 执行一次行动图，返回最终结果与快照。
 *
 * 一次行动一条线程，线程键就是行动键，谁也不会接着别人的半截状态往下跑。
 * 接着跑时从断点往下走：前面那几个节点已经问过的模型调用不再重问——采样是随机的，
 * 重问一次问出来的就不是同一份答案了，那一局也不再是同一局。
 *
 * 质疑是独立的，不会把不合要求的草稿往下传：留到质疑那里再发现，白花一次调用。
 * 修订是独立的，不会再回头质疑：改完的那版才是最终决定。
 *
 * @param runtime 模型端口与接入身份
 * @param request 行动请求，包含行动类型、玩家身份、行动档位、行动序号、局面与任务、输出形状等信息
 * @param options 执行进度的存法，以及这一次是接着上次跑还是从头跑
 * @returns 最终结果与快照，包含校验过的结果、快照信息等
 */
export async function runActionGraph(
  runtime: TurnRuntime,
  request: ActionRequest,
  options: ActionGraphOptions = {},
): Promise<TurnOutcome> {
  const { saver, resume } = options;
  const graph = actionGraphOf(saver);
  const config = {
    context: { runtime, request },
    configurable: {
      // 线程键取行动键：落库那份进度按它归档，一局里每一问各是各的。
      thread_id: actionKeyOf(request),
    },
    // 每一步跑完就落盘，不留到下一步再去写：中间断了，那一步的答案就白问了。
    durability: 'sync' as const,
  };

  // 空线程拿 null 起跑会当场抛：库里没有断点时，这一轮的开头还得自己喂进去。
  const behind =
    resume === true && saver !== undefined && (await saver.getTuple(config)) !== undefined;
  let outcome: TurnOutcome | null = null;
  let active: { id: string; name: string } | undefined;
  const emit = (
    task: { id: string; name: string },
    status: ActionStep['status'],
    text = '',
    thinkingMs?: number | null,
  ) => {
    runtime.preview?.({
      actionKey: actionKeyOf(request),
      day: request.context.day,
      seatNo: request.context.actor.seatNo,
      actionType: request.actionType,
      step: task.name,
      callId: task.id,
      channel: 'node',
      status,
      text,
      ...(thinkingMs != null ? { thinkingMs } : {}),
    });
  };
  try {
    // 节点起止来自 LangGraph，预览只负责转换成观战契约。
    for await (const [mode, data] of await graph.stream(behind ? null : {}, {
      ...config,
      streamMode: ['tasks', 'values'],
    })) {
      if (mode === 'values') {
        outcome = data.outcome;
      } else if ('input' in data) {
        active = data;
        emit(data, 'running');
      } else {
        const result = data.result as unknown as Partial<TurnStateValue>;
        // 失败任务也会发 result，但没有状态写入；随后迭代器才抛出异常。
        if (Object.keys(result).length > 0) {
          emit(data, 'completed', stepContent(data.name, result), result.thinkingMs);
          active = undefined;
        }
      }
    }
  } catch (error) {
    if (active) emit(active, 'failed', '节点执行失败，可在恢复对局后重试。');
    throw error;
  }
  if (!outcome) throw new Error('行动图跑完了却没有结果');
  return outcome;
}

/** 展开行动时读取原生检查点中的任务结果，不额外保存一套执行日志。 */
export async function actionSteps(saver: BaseCheckpointSaver, key: string): Promise<ActionStep[]> {
  const graph = actionGraphOf(saver);
  const steps = new Map<string, ActionStep>();
  const advanced = new Map<string, Partial<TurnStateValue>>();
  for await (const snapshot of graph.getStateHistory({ configurable: { thread_id: key } })) {
    const nextValues = advanced.get(snapshot.config.configurable?.checkpoint_id as string);
    for (const task of snapshot.tasks) {
      if (task.name === START) continue;
      if (steps.has(task.id)) continue;
      // 续跑后旧任务可能还带着 error；后继检查点已提交才是完成的依据。
      const result = (nextValues ?? task.result) as Partial<TurnStateValue> | undefined;
      const failed = !nextValues && Boolean(task.error);
      steps.set(task.id, {
        id: task.id,
        name: task.name,
        status: failed ? 'failed' : result ? 'completed' : 'running',
        content: failed ? '节点执行失败' : stepContent(task.name, result),
        reasoning:
          task.name === 'finalize'
            ? null
            : ((task.name === 'critique' ? result?.critiqueReasoning : result?.reasoning) ?? null),
        thinkingMs: task.name === 'finalize' ? null : (result?.thinkingMs ?? null),
      });
    }
    const parent = snapshot.parentConfig?.configurable?.checkpoint_id as string | undefined;
    if (parent && snapshot.metadata?.source === 'loop' && !advanced.has(parent)) {
      advanced.set(parent, snapshot.values as Partial<TurnStateValue>);
    }
  }
  return [...steps.values()].toReversed();
}

function stepContent(name: string, result?: Partial<TurnStateValue>): string {
  if (name === 'critique' && result?.verdict) {
    return `${result.verdict.accept ? '复核通过' : '需要修订'}${result.verdict.issues ? `：${result.verdict.issues}` : ''}`;
  }
  if (name === 'finalize' && result?.outcome) return '行动结果已确认';
  if (result && 'decision' in result) {
    return typeof result.decision === 'string' ? result.decision : JSON.stringify(result.decision);
  }
  return result?.draft ?? '';
}
