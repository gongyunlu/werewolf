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
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
} from './model-port';

/** 发请求的口子，形状照着 fetch 走。用例里照着造一个就行。 */
export type SendRequest = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** 一次请求的收发口子。超时与请求实现都从这儿进，用例里换成假的。 */
export interface OpenaiModelPortOptions {
  /** 单次请求的上限毫秒数。实测只管到响应头：流式下成了流之后，正文拖多久都不中止。 */
  timeoutMs?: number;
  /** 只用来替换实现，跑起来就是全局 fetch。 */
  fetch?: SendRequest;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** 答案正文，OpenAI 那套：取第一条 choice 的 message.content。 */
const RESPONSE = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
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
): Promise<ModelResponse> {
  let full = '';
  let started = false;
  let emitted = false;

  try {
    const stream = await client.chat.completions.create(params);
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
    if (!started) throw asModelCallError(error, url);
    throw streamFailure(error, url, emitted);
  }

  // 一个字的正文都没收到，跟一次收完时收到空白是同一件事。
  // 但吐过空白分片的另说：调用方手里已经拿到一段了，重发会接在它后面。
  if (full.trim() === '') {
    throw new ModelCallError('transient', `${url} 的答复正文是空的`, { partialOutput: emitted });
  }
  return { content: full };
}

/**
 * OpenAI 兼容的模型端口：一次 generate 一次请求，收完整的答复。
 *
 * 走官方 SDK 而不是自己拼 HTTP，图的是流式那一侧：SSE 的分片、半包、收尾都由它管，
 * 而它的错误对象保留着状态码、响应头和解析开的报文——这几点是选它而不是选 LangChain 那层包装的原因。
 *
 * 不传 response_format：端口收到的是一次拼好的提示词，里面没有结构定义，
 * 而发言那几问要的本来就是一段自然语言。结构化与否由调用方在提示词里说清、自己解析，
 * 端口不替它选。
 */
export function openaiModelPort(options: OpenaiModelPortOptions = {}): ModelPort {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetch: send } = options;

  /** 一次请求一个客户端。密钥和端点按次给，实例就不留着了。 */
  function clientFor(access: ModelAccess): OpenAI {
    return new OpenAI({
      apiKey: access.apiKey,
      baseURL: endpointOf(access.baseUrl),
      timeout: timeoutMs,
      // 重试归上层那一层管。SDK 自己再试一遍就是两层重试相乘，一次失败能烧掉十几次调用，
      // 而且最后报出来的错分不清是哪一层在试。
      maxRetries: 0,
      ...(send ? { fetch: send } : {}),
    });
  }

  return {
    async generate(
      request: ModelRequest,
      access: ModelAccess,
      onDelta?: (delta: string) => void,
    ): Promise<ModelResponse> {
      const url = `${endpointOf(access.baseUrl)}/chat/completions`;
      const client = clientFor(access);
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ];
      // 关思维链那个参数各家写法不一样，形状由能力声明带进来；这家没有就是空对象。
      const extra = access.capability.reasoningOff ?? {};
      const params = { model: access.model, messages, ...extra };

      if (onDelta) return collectStream(client, { ...params, stream: true }, url, onDelta);

      let answer: unknown;
      try {
        answer = await client.chat.completions.create(params);
      } catch (error) {
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

      // min(1) 已经保证有第一条，空正文才是要拦的那个：它走到调用方那儿只会变成一句
      // 「模型没答」，那时已经看不见这次请求的来龙去脉了。同样是这次没拿到。
      const text = content.data.choices[0].message.content;
      if (text.trim() === '') throw new ModelCallError('transient', `${url} 的答复正文是空的`);
      return { content: text };
    },
  };
}
