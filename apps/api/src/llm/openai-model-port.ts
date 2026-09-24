import OpenAI, { APIError } from 'openai';
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { z } from 'zod';
import { endpointOf } from './model-capability';
import { usageObject, type RequestMetrics } from './observation';
import {
  ModelCallError,
  type ModelAccess,
  type ModelCallOptions,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type ModelTool,
  type StreamDelta,
} from './model-port';

/** 发请求的口子，形状照着 fetch 走。用例里照着造一个就行。 */
export type SendRequest = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** 一次请求的收发口子。超时与请求实现都从这儿进，用例里换成假的。 */
export interface OpenaiModelPortOptions {
  /** 单次调用的上限毫秒数，不传就是这个默认值。 */
  timeoutMs?: number;
  /** 只用来替换实现，跑起来就是全局 fetch。 */
  fetch?: SendRequest;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 这次调用的信号：截止时间和调用方的喊停合成一个，哪个先到都算这次结束。
 *
 * 不交给 SDK 自己的 timeout：它只管到响应头，流式下成了流之后正文拖多久都不中止。
 * 由信号管则一条路径到底，连「是谁喊的停」也一起带得出来。
 */
function callSignal(call: ModelCallOptions, timeoutMs: number): AbortSignal {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (call.signal) signals.push(call.signal);
  return AbortSignal.any(signals);
}

/**
 * 被中止的归类：端口自己那个超时归 transient，调用方喊停归 deadline。
 *
 * 两者分开是因为该不该再来一次不一样：单次调用的上限是「这次没赶上」，端点这次排得久、
 * 下次未必，重发一次还有戏；调用方喊停是整件事不做了（阶段超期、整局停掉），
 * 再发一次只是白等，而且它已经不要这份答复了。
 *
 * 判据取信号而不是错误的形状：中止在各层冒出来的样子不一样（fetch 的 AbortError、
 * SDK 自己包的那层、流读到一半断掉），信号只有一个。
 */
function aborted(signal: AbortSignal, url: string, emitted: boolean): ModelCallError {
  const { reason } = signal;
  // 按名字判而不是 instanceof：本机跑起来是 DOMException，而这一层用的 fetch 实现
  // 换一个（undici 之外的、浏览器里的）抛的就不是同一个类，判错会把该重发的当成不该重发的。
  const name = (reason as { name?: unknown } | undefined)?.name;
  const timedOut = name === 'TimeoutError';
  return new ModelCallError(
    timedOut ? 'transient' : 'deadline',
    `${url} 的这次调用${timedOut ? '超时' : '被中止'}`,
    { cause: reason, partialOutput: emitted },
  );
}

/**
 * 答复正文，OpenAI 那套：取第一条 choice 的 message。
 * 正文与工具调用至少有一个：走工具时正文是空串，写正文时没有 tool_calls。
 *
 * reasoning_content 是思考那一段的字段名。跟 content 是两条独立的通道，走不走工具都可能有它。
 */
const RESPONSE = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          reasoning_content: z.string().nullish(),
          tool_calls: z
            .array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullish(),
        }),
      }),
    )
    .min(1),
});

function checkFinishReason(reason: string | null | undefined, url: string, emitted = false): void {
  if (reason != null && reason !== 'stop' && reason !== 'tool_calls') {
    throw new ModelCallError('invalid_output', `${url} 的输出被截断：${reason}`, {
      partialOutput: emitted,
    });
  }
}

/**
 * 报文里出现配额字样，这类 429 再试也还是同一个结果。
 * 不逐字列各家那串代号：漏认一个，配额用尽就会被当成限流，重试三次再报一句「都没成」，
 * 真正该去处理的原因反倒看不见了；多认一个顶多是少重试一次，代价小得多。
 */
const QUOTA_EXHAUSTED = /quota/i;

/**
 * 按 HTTP 状态和报文归类。分类决定上层要不要重试，归错了就是白等或者白试。
 * 只有 408、5xx 和「非配额类的 429」算 transient；其余 4xx 重发多少次都是同一个拒绝。
 */
function codeOf(status: number, detail: string): ModelCallError['code'] {
  if (status === 429) return QUOTA_EXHAUSTED.test(detail) ? 'fatal' : 'transient';
  if (status === 408 || status >= 500) return 'transient';
  return 'fatal';
}

/**
 * 端点让过多久再来，毫秒。
 * 标准写的是秒数；写成 HTTP 日期那种形式的一律当没写，退回按退避等——总比把日期当成秒数、
 * 等上几万秒强。没有这个头也当没写。
 */
function retryAfterOf(headers: unknown): number | undefined {
  if (!(headers instanceof Headers)) return undefined;
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
}

/**
 * 报文里的字样。SDK 把正文拆成了码和对象，再拼回一段文本，好跟状态码一起判。
 *
 * 正文不是 JSON 的时候（网关拦下来塞的 HTML、限流说明写成纯文本的）SDK 不解析，
 * 整段原样放在 message 里，`error` 与 `code` 都是空的。只读那两个字段的话，
 * 配额用尽会被当成限流白重试三次，网关给的那段说明也一个字都留不下。
 */
function detailOf(error: APIError): string {
  const body =
    typeof error.error === 'string'
      ? error.error
      : error.error === undefined
        ? error.message
        : JSON.stringify(error.error);
  return `${error.code ?? ''} ${body}`.slice(0, 500);
}

/** 把一个值压成好读的一段文本，塞进报错里用。 */
function textOf(value: unknown): string {
  return (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).slice(0, 500);
}

/**
 * 这次请求的工具那一截。不给工具就是空对象，不往请求里塞一个空数组。
 * 只提供一个工具。默认要求调用它，不支持强制调用的端点按能力声明使用 auto。
 */
function toolParams(
  tool: ModelTool | undefined,
  choice: 'required' | 'auto',
): Record<string, unknown> {
  if (!tool) return {};
  return {
    tools: [
      {
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      },
    ],
    tool_choice: choice,
  };
}

/**
 * 把 SDK 抛出来的东西翻成这一层的错码。认不出来的一律原样抛。
 *
 * 原样抛是有意的：拼不成 URL 这类本地配置的毛病，SDK 抛的是裸 TypeError，不裹。
 * 裹成 transient 只会被重试三次再报一句「都没成」，把真正的原因盖掉。
 */
function asModelCallError(error: unknown, url: string): ModelCallError {
  if (!(error instanceof APIError)) throw error;
  // 连不上和超时没有状态码，SDK 也把它们挂在 APIError 底下，得先挑出来。
  if (error.status === undefined) {
    return new ModelCallError('transient', `${url} 请求没发出去：${error.message}`, {
      cause: error,
    });
  }

  const detail = detailOf(error);
  return new ModelCallError(
    codeOf(error.status, detail),
    `${url} 返回 ${error.status}：${detail}`,
    { cause: error, retryAfterMs: retryAfterOf(error.headers) },
  );
}

/**
 * 流断在半路的归类：一律按「这次没读完」算，重发一次还有戏。
 *
 * 迭代期的异常大多不带状态码，分不清是端点拒绝还是连接断了，所以不细分。
 * 已实测两种会落到这儿的其它情况：流里读到错误报文时 SDK 抛的是没有状态码的 APIError；
 * 调用方自己的 onDelta 抛错也走这条。眼下都当流断。
 */
function streamFailure(error: unknown, url: string, emitted: boolean): ModelCallError {
  const detail = error instanceof Error ? error.message : String(error);
  return new ModelCallError('transient', `${url} 的答复读到一半断了：${detail}`, {
    cause: error,
    // 已经交给调用方的预览不能作为完整答复提交。
    partialOutput: emitted,
  });
}

/** 思考与正文分别推送累计文本，工具参数收齐后返回。 */
async function collectStream(
  client: OpenAI,
  params: ChatCompletionCreateParamsStreaming,
  url: string,
  onDelta: (delta: StreamDelta) => void,
  signal: AbortSignal,
  metrics: RequestMetrics,
): Promise<ModelResponse> {
  let content = '';
  let reasoning = '';
  let thinkingStarted: number | undefined;
  let thinkingEnded: number | undefined;
  let finishReason: string | null = null;
  let finalUsage = false;
  /** 工具参数按 index 归拢：头一片带名字，后面的分片只带参数碎片。 */
  const calls = new Map<number, { name: string; arguments: string }>();
  let started = false;
  // 吐过的是正文那一头。思考不算：它不往哪段话里接，重发一段新的不会跟它拼出两截话来。
  let emitted = false;

  try {
    const stream = await client.chat.completions.create(params, { signal });
    started = true;
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      // 最后一片可以只有 usage、没有 choice。累计用量覆盖旧值，不逐片相加。
      const usage = usageObject(chunk.usage);
      if (usage) {
        metrics.usage = usage;
        // 只将结束分片及其后的用量视为最终值，中途累计值仍保留为部分用量。
        finalUsage = finishReason !== null;
      }
      const delta = choice?.delta;
      if (!delta) continue;

      // reasoning_content 是思考那一段的字段名，供应商的扩展，SDK 的类型里没有它。
      const thought = (delta as { reasoning_content?: string | null }).reasoning_content;
      if (thought) {
        thinkingStarted ??= Date.now();
        reasoning += thought;
        onDelta({
          channel: 'reasoning',
          text: reasoning,
          thinkingMs: Date.now() - thinkingStarted,
        });
      }

      if (thinkingStarted !== undefined && (delta.content || delta.tool_calls?.length)) {
        thinkingEnded ??= Date.now();
      }

      for (const piece of delta.tool_calls ?? []) {
        const call = calls.get(piece.index) ?? { name: '', arguments: '' };
        if (piece.function?.name) call.name = piece.function.name;
        if (piece.function?.arguments) call.arguments += piece.function.arguments;
        calls.set(piece.index, call);
      }

      if (!delta.content) continue;
      content += delta.content;
      emitted = true;
      onDelta({
        channel: 'content',
        text: content,
        ...(thinkingStarted !== undefined ? { thinkingMs: thinkingEnded! - thinkingStarted } : {}),
      });
    }
  } catch (error) {
    // 中止排在最前面：被喊停的流和半路断掉的流长得一样，得先分辨出来，
    // 不然一次「不要了」会被当成这次没读完，重发一遍。
    if (signal.aborted) throw aborted(signal, url, emitted);
    if (!started) throw asModelCallError(error, url);
    throw streamFailure(error, url, emitted);
  }

  // 被中止的流未必抛错：SDK 收到底层读到一半被中止时是把迭代就地收尾（它自己的分类见
  // createAbortableSSESource），这一条不拦，超时会被当成一次「答到一半就结束」的正常答复
  // ——拿到手的是一段残文，调用方却以为那是对它的完整回答。
  if (signal.aborted) throw aborted(signal, url, emitted);

  metrics.usageComplete = finalUsage;

  if (finishReason === null) {
    throw new ModelCallError('transient', `${url} 的流缺少结束原因`, { partialOutput: emitted });
  }
  checkFinishReason(finishReason, url, emitted);

  // 一次只提供一个提交工具，取它的参数。
  const invoked = [...calls.values()][0];

  // 一个字的正文都没收到，跟一次收完时收到空白是同一件事。
  // 走工具时正文本来就是空的，答案在参数那一头：只看正文会把这次判成没拿到，
  // 白重试三次还是同一个结果。
  if (content.trim() === '' && !invoked) {
    throw new ModelCallError('transient', `${url} 的答复正文是空的`, { partialOutput: emitted });
  }

  // 参数是空串就是这一问一个字都没答上，跟正文空着是一回事：归 transient 让重试层重发一遍。
  if (invoked && invoked.arguments.trim() === '') {
    throw new ModelCallError('transient', `${url} 的工具参数是空的`, { partialOutput: emitted });
  }

  return {
    content,
    toolCall: invoked ? { name: invoked.name, arguments: invoked.arguments } : null,
    // 端点没给思考就是空串，按没给算——留个空串会让「有没有思考」多出一种分不清真假的形态。
    reasoning: reasoning === '' ? null : reasoning,
    ...(thinkingStarted !== undefined
      ? { thinkingMs: (thinkingEnded ?? Date.now()) - thinkingStarted }
      : {}),
  };
}

/** 使用官方 SDK 调用兼容端点，保留供应商的思考字段并归类失败原因。 */
export function openaiModelPort(options: OpenaiModelPortOptions = {}): ModelPort {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetch: send } = options;

  /** 一次请求一个客户端。密钥和端点按次给，实例就不留着了。 */
  function clientFor(
    access: ModelAccess,
    metrics: RequestMetrics,
    dispatched?: () => void,
  ): OpenAI {
    return new OpenAI({
      apiKey: access.apiKey,
      baseURL: endpointOf(access.baseUrl),
      // 超时与中止都归信号管，见 callSignal。
      // 重试归上层那一层管：SDK 自己再试一遍就是两层重试相乘，一次失败能烧掉十几次调用，
      // 而且最后报出来的错分不清是哪一层在试。
      maxRetries: 0,
      fetch: async (input, init) => {
        metrics.dispatched = true;
        dispatched?.();
        const response = await (send ?? fetch)(input, init);
        metrics.httpStatus = response.status;
        metrics.requestId = response.headers.get('x-request-id');
        return response;
      },
    });
  }

  async function requestOnce(
    request: ModelRequest,
    access: ModelAccess,
    call: ModelCallOptions,
    metrics: RequestMetrics,
    dispatched?: () => void,
  ): Promise<ModelResponse> {
    const url = `${endpointOf(access.baseUrl)}/chat/completions`;
    // 已经喊停的 signal 由 SDK 自己拦下：它一个请求都不会发，抛出来的错照样落到下面那条
    // 「signal 已中止」的判定上。这儿不再多查一遍。
    const signal = callSignal(call, call.timeoutMs ?? timeoutMs);
    const client = clientFor(access, metrics, dispatched);
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ];
    // 关思维链那个参数各家写法不一样，形状由能力声明带进来；这家没有就是空对象。
    const extra = access.capability.reasoningOff ?? {};
    const params = {
      model: access.model,
      messages,
      ...extra,
      ...toolParams(request.tool, access.capability.toolChoice ?? 'required'),
    };

    // 走工具也照样能流：思考那一段在工具参数之前到，跟正文是两条通道。
    // 走的这一路只推思考，工具参数拼到收尾才交出去。
    if (call.onDelta) {
      return collectStream(
        client,
        {
          ...params,
          stream: true,
          ...(access.capability.streamUsage ? { stream_options: { include_usage: true } } : {}),
        },
        url,
        call.onDelta,
        signal,
        metrics,
      );
    }

    let answer: unknown;
    try {
      answer = await client.chat.completions.create(params, { signal });
    } catch (error) {
      if (signal.aborted) throw aborted(signal, url, false);
      // SDK 只在 content-type 不是 JSON 时把正文原样交出来；它认了 JSON 头而正文又不是 JSON 时，
      // 抛的是它自己 JSON.parse 的裸 SyntaxError，带不进 APIError。这跟网关塞段 HTML 是一回事
      // ——这次没拿到，重发就有戏。不裹的话它会穿过重试层，报一个指不到端点的解析错。
      if (error instanceof SyntaxError) {
        throw new ModelCallError('transient', `${url} 的答复不是合法 JSON：${error.message}`, {
          cause: error,
        });
      }
      throw asModelCallError(error, url);
    }

    metrics.usage = usageObject(usageObject(answer)?.usage);
    metrics.usageComplete = metrics.usage !== null;
    const content = RESPONSE.safeParse(answer);
    // 正文不是 JSON 的时候 SDK 原样把那段文本交出来，所以报错里还留得下网关塞的东西。
    //
    // 归 transient 不归 invalid_output：正文不是 JSON、choices 是空，都是「这次没拿到」，
    // 跟网络抖一下是一回事，重发就能成。模型答得不合规是另一回事，那归调用方那边的
    // invalid_output——那一层看得见解析，重问也归它发。
    if (!content.success) {
      throw new ModelCallError('transient', `${url} 的答复不合结构：${textOf(answer)}`, {
        cause: content.error,
      });
    }

    // min(1) 已经保证有第一条，空答复才是要拦的那个：它走到调用方那儿只会变成一句
    // 「模型没答」，那时已经看不见这次请求的来龙去脉了。同样是这次没拿到。
    //
    // 走工具时正文本来就是空的，答案在 tool_calls 那一头：只看正文会把这次判成没拿到，
    // 白重试三次还是同一个结果。
    const choice = content.data.choices[0];
    checkFinishReason(choice.finish_reason, url);
    const message = choice.message;
    const text = message.content ?? '';
    const invoked = message.tool_calls?.[0];
    if (text.trim() === '' && !invoked) {
      throw new ModelCallError('transient', `${url} 的答复正文是空的`);
    }

    // 参数是空串就是这一问一个字都没答上，跟正文空着是一回事：归 transient 让重试层重发一遍。
    // 放它落到解析层，报出来的会是「整串不是合法 JSON」，附言里引一对空的「」，指错了地方。
    if (invoked && invoked.function.arguments.trim() === '') {
      throw new ModelCallError('transient', `${url} 的工具参数是空的`);
    }

    return {
      content: text,
      toolCall: invoked
        ? { name: invoked.function.name, arguments: invoked.function.arguments }
        : null,
      reasoning: message.reasoning_content ?? null,
    };
  }

  return {
    async generate(request, access, call = {}) {
      const complete = await call.startAttempt?.();
      const metrics: RequestMetrics = {
        dispatched: false,
        durationMs: 0,
        httpStatus: null,
        requestId: null,
        usage: null,
        usageComplete: false,
        thinkingMs: null,
      };
      const started = performance.now();
      let response: ModelResponse;
      try {
        response = await requestOnce(request, access, call, metrics, complete?.dispatched);
      } catch (error) {
        metrics.durationMs = performance.now() - started;
        const code = error instanceof ModelCallError ? error.code : 'internal';
        await complete?.finish({
          ...metrics,
          status: code === 'deadline' ? 'cancelled' : 'failed',
          failureCode: code,
        });
        throw error;
      }
      metrics.durationMs = performance.now() - started;
      metrics.thinkingMs = response.thinkingMs ?? null;
      await complete?.finish({ ...metrics, status: 'succeeded', failureCode: null });
      return response;
    },
  };
}
