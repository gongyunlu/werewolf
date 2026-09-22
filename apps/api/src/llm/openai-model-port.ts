import OpenAI, { APIError } from 'openai';
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { z } from 'zod';
import { endpointOf } from './model-capability';
import {
  ModelCallError,
  type ModelAccess,
  type ModelCallOptions,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type ModelTool,
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
 * tool_choice 点名那一个工具，模型必须调它，不能改成写一段正文。
 */
function toolParams(tool: ModelTool | undefined): Record<string, unknown> {
  if (!tool) return {};
  return {
    tools: [
      {
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      },
    ],
    tool_choice: { type: 'function', function: { name: tool.name } },
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
    // 已经在吐字的另说：那半截话调用方拿到手了，重发就是把两段话接在一起。
    partialOutput: emitted,
  });
}

/**
 * 收一次流式答复：收到一段交出去一段，最后把全文一起给。
 *
 * HTTP 那一层就没成（状态码不对）的在 create() 上抛，那儿照常按状态码归类；
 * 成了流之后才断的走 streamFailure——那时已经拿不到状态码，按「这次没读完」算，
 * 吐过字的标上 partialOutput。
 */
async function collectStream(
  client: OpenAI,
  params: ChatCompletionCreateParamsStreaming,
  url: string,
  onDelta: (delta: string) => void,
  signal: AbortSignal,
): Promise<ModelResponse> {
  let full = '';
  let started = false;
  let emitted = false;

  try {
    const stream = await client.chat.completions.create(params, { signal });
    started = true;
    for await (const chunk of stream) {
      // choices 整个缺键的分片（有些网关只推一段 usage）会让 [0] 直接抛 TypeError。
      const delta = chunk.choices?.[0]?.delta?.content;
      if (!delta) continue;
      full += delta;
      emitted = true;
      onDelta(delta);
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

  // 一个字的正文都没收到，跟一次收完时收到空白是同一件事。
  // 但吐过空白分片的另说：调用方手里已经拿到一段了，重发会接在它后面。
  if (full.trim() === '') {
    throw new ModelCallError('transient', `${url} 的答复正文是空的`, { partialOutput: emitted });
  }
  // 流式那一侧不接受工具，见上面那条拦：走到这儿的答复一定是正文写出来的。
  // 思考那一段不取：它走的是分片上的另一个字段，眼下这一步没有调用方，等真有人用再接。
  return { content: full, toolCall: null, reasoning: null };
}

/**
 * OpenAI 兼容的模型端口：一次 generate 一次请求，收完整的答复。
 *
 * 走官方 SDK 而不是自己拼 HTTP，图的是流式那一侧：SSE 的分片、半包、收尾都由它管，
 * 而它的错误对象保留着状态码、响应头和解析开的报文——这几点是选它而不是选 LangChain 那层包装的原因。
 *
 * 要结构化就由调用方给一份工具定义，这儿用 tool_choice 点名那一个工具逼它调；不给就是写一段话。
 * 不走 response_format：那也是「按 schema 输出 JSON」，但形状约束不如工具硬，
 * 而且这几问每次要的东西不一样，工具定义得按这一次的形状现造。
 */
export function openaiModelPort(options: OpenaiModelPortOptions = {}): ModelPort {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetch: send } = options;

  /** 一次请求一个客户端。密钥和端点按次给，实例就不留着了。 */
  function clientFor(access: ModelAccess): OpenAI {
    return new OpenAI({
      apiKey: access.apiKey,
      baseURL: endpointOf(access.baseUrl),
      // 超时与中止都归信号管，见 callSignal。
      // 重试归上层那一层管：SDK 自己再试一遍就是两层重试相乘，一次失败能烧掉十几次调用，
      // 而且最后报出来的错分不清是哪一层在试。
      maxRetries: 0,
      ...(send ? { fetch: send } : {}),
    });
  }

  return {
    async generate(
      request: ModelRequest,
      access: ModelAccess,
      call: ModelCallOptions = {},
    ): Promise<ModelResponse> {
      const url = `${endpointOf(access.baseUrl)}/chat/completions`;
      // 已经喊停的 signal 由 SDK 自己拦下：它一个请求都不会发，抛出来的错照样落到下面那条
      // 「signal 已中止」的判定上。这儿不再多查一遍。
      const signal = callSignal(call, call.timeoutMs ?? timeoutMs);
      const client = clientFor(access);
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ];
      // 关思维链那个参数各家写法不一样，形状由能力声明带进来；这家没有就是空对象。
      const extra = access.capability.reasoningOff ?? {};
      const params = { model: access.model, messages, ...extra, ...toolParams(request.tool) };

      if (call.onDelta) {
        // 走工具时没有正文可推：真到这一步是调用方把两个口子一起给了，当场停下比闷着不吐字强。
        if (request.tool) {
          throw new ModelCallError('fatal', '流式与工具一起给：走工具时没有正文可以一段段推');
        }
        return collectStream(client, { ...params, stream: true }, url, call.onDelta, signal);
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
      const message = content.data.choices[0].message;
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
    },
  };
}
