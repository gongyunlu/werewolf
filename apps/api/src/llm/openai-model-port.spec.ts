import { openaiModelPort, type SendRequest } from './openai-model-port';
import { ModelCallError, type ModelAccess } from './model-port';

const BASE_URL = 'https://model.example.test/v1';

// 密钥得是 ASCII：SDK 把它塞进 HTTP 头，而头只收字节串。
const ACCESS: ModelAccess = {
  baseUrl: BASE_URL,
  model: '用例模型',
  apiKey: 'sk-test',
  capability: { allowCodeFence: false, reasoningOff: { thinking: { type: 'disabled' } } },
};

const REQUEST = { system: '你是谁', prompt: '要你做什么' };

/** 答复正文包成 OpenAI 那种形状。 */
function answer(content: string): string {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
}

/** 一次收发都没发出去的记录；断言 URL、头、请求体时看它。 */
interface Sent {
  url: string;
  init: RequestInit | undefined;
}

/** 造一个按状态码和正文作答的收发口子，把每次请求记下来。 */
function fakeSend(status: number, body: string, headers: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const send: SendRequest = (url, init) => {
    sent.push({ url: String(url), init });
    return Promise.resolve(
      new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } }),
    );
  };
  return { send, sent };
}

/** 造一个直接抛错的收发口子，模拟连不上。 */
function failingSend(error: Error): SendRequest {
  return async () => {
    throw error;
  };
}

/** 正文读到一半断了。 */
const die = () => Promise.reject(new Error('socket hang up'));

/**
 * 造一个正文断在半路的答复：状态码是好的，读的时候才炸。
 * text 和 json 都堵上，因为不确知 SDK 走哪一条去取正文。
 */
function cutOffSend(status = 200): SendRequest {
  return async () => {
    const response = new Response('{}', { status });
    Object.defineProperty(response, 'text', { value: die });
    Object.defineProperty(response, 'json', { value: die });
    return response;
  };
}

/** 流里的一段，包成 OpenAI 那种形状。 */
function chunkOf(text: string): string {
  const chunk = {
    id: 'x',
    object: 'chat.completion.chunk',
    created: 0,
    model: '用例模型',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** 造一段正常的流式答复，每段正文一片。 */
function sseSend(...deltas: string[]): SendRequest {
  const body = deltas.map(chunkOf).join('') + 'data: [DONE]\n\n';
  return async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * 造一段吐到一半就断的流。
 * 分片得先真的交出去，断的那一下才算「已经吐过字」，所以用 pull 一片一片地给，
 * 等读的人要下一片时才断。
 */
function sseThenDie(text: string): SendRequest {
  const chunk = new TextEncoder().encode(chunkOf(text));
  let delivered = false;
  return async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (!delivered) {
            delivered = true;
            controller.enqueue(chunk);
            return;
          }
          controller.error(new Error('socket hang up'));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
}

/** 造一段 HTTP 那一层就被拒的流式请求：还没成流，状态码和响应头都还在。 */
function refusedStream(): SendRequest {
  return async () =>
    new Response(JSON.stringify({ error: { code: 'RateLimitExceeded' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '2' },
    });
}

/** 造一段一开就断的流：HTTP 是通的，一个字的正文都没来。 */
function sseDieBeforeContent(): SendRequest {
  return async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('socket hang up'));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
}

/** 取请求体，解开后按对象看。 */
function bodyOf(sent: readonly Sent[]): Record<string, unknown> {
  return JSON.parse(String(sent[0]?.init?.body)) as Record<string, unknown>;
}

/** 取请求头里某一项。SDK 传下来的是一份 Headers，不是普通对象。 */
function headerOf(sent: readonly Sent[], name: string): string | null {
  return new Headers(sent[0]?.init?.headers).get(name);
}

/** 跑一次并把它抛出来的失败分类取回来；没抛就是用例自己写错了。 */
async function failureOf(port: ReturnType<typeof openaiModelPort>) {
  try {
    await port.generate(REQUEST, ACCESS);
  } catch (error) {
    return error as ModelCallError;
  }
  throw new Error('本该抛错');
}

describe('OpenAI 兼容模型端口', () => {
  describe('正常收发', () => {
    it('取第一条 choice 的正文交出去', async () => {
      const { send } = fakeSend(200, answer('我坐 3 号，先听前面的。'));

      await expect(openaiModelPort({ fetch: send }).generate(REQUEST, ACCESS)).resolves.toEqual({
        content: '我坐 3 号，先听前面的。',
      });
    });

    it('打到端点的 chat/completions，型号、两段提示词和能力给的片段一起带上', async () => {
      const { send, sent } = fakeSend(200, answer('好'));

      await openaiModelPort({ fetch: send }).generate(REQUEST, ACCESS);

      expect(sent[0]?.url).toBe(`${BASE_URL}/chat/completions`);
      expect(sent[0]?.init?.method).toBe('POST');
      expect(bodyOf(sent)).toEqual({
        model: '用例模型',
        messages: [
          { role: 'system', content: '你是谁' },
          { role: 'user', content: '要你做什么' },
        ],
        thinking: { type: 'disabled' },
      });
    });

    it('端点末尾多一个斜杠也不会打重', async () => {
      const { send, sent } = fakeSend(200, answer('好'));

      await openaiModelPort({ fetch: send }).generate(REQUEST, {
        ...ACCESS,
        baseUrl: `${BASE_URL}/`,
      });

      expect(sent[0]?.url).toBe(`${BASE_URL}/chat/completions`);
    });

    it('密钥按 Bearer 带上去', async () => {
      const { send, sent } = fakeSend(200, answer('好'));

      await openaiModelPort({ fetch: send }).generate(REQUEST, { ...ACCESS, apiKey: 'sk-fetched' });

      expect(headerOf(sent, 'authorization')).toBe('Bearer sk-fetched');
    });

    it('能力里没给关思维链的片段就不带它，也从不发 response_format', async () => {
      const { send, sent } = fakeSend(200, answer('好'));

      await openaiModelPort({ fetch: send }).generate(REQUEST, {
        ...ACCESS,
        capability: { allowCodeFence: false, reasoningOff: null },
      });

      // 发言那几问要的就是一段自然语言，端口自己发 response_format 会把正文逼成 JSON。
      expect(bodyOf(sent)).toEqual({
        model: '用例模型',
        messages: [
          { role: 'system', content: '你是谁' },
          { role: 'user', content: '要你做什么' },
        ],
      });
    });

    it('端点拼不成 URL 就原样抛，不裹成 transient', async () => {
      const { send, sent } = fakeSend(200, answer('好'));

      const error = await openaiModelPort({ fetch: send })
        .generate(REQUEST, { ...ACCESS, baseUrl: '不是一个 URL' })
        .catch((thrown: unknown) => thrown);

      // 裹成 ModelCallError 就会被重试三次再报一句「都没成」，真正的原因就看不见了。
      expect(error).not.toBeInstanceOf(ModelCallError);
      // 按名字判，不按 toBeInstanceOf(TypeError)：jest 沙箱里的 TypeError 与 Node 抛的不是同一个。
      expect((error as Error).name).toBe('TypeError');
      expect(sent).toHaveLength(0);
    });

    it('超时按选项中止请求，归 transient', async () => {
      const sent: Sent[] = [];
      // 一直不回，只有端口自己那个超时能把它中止掉：超时时间没接上的话这个用例会挂在这儿。
      const hanging: SendRequest = (url, init) => {
        sent.push({ url: String(url), init });
        return new Promise<Response>((_done, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      };

      const error = await failureOf(openaiModelPort({ fetch: hanging, timeoutMs: 20 }));

      expect(error.code).toBe('transient');
      expect(sent[0]?.init?.signal?.aborted).toBe(true);
    });
  });

  describe('流式', () => {
    /** 跑一次流式，把抛出来的分类取回来；没抛就是用例自己写错了。 */
    async function streamFailureOf(port: ReturnType<typeof openaiModelPort>, deltas: string[]) {
      try {
        await port.generate(REQUEST, ACCESS, (delta) => deltas.push(delta));
      } catch (error) {
        return error as ModelCallError;
      }
      throw new Error('本该抛错');
    }

    it('收到一段交出去一段，返回值是拼起来的全文', async () => {
      const port = openaiModelPort({ fetch: sseSend('我坐', ' 3 号，', '先听前面的。') });
      const deltas: string[] = [];

      const full = await port.generate(REQUEST, ACCESS, (delta) => deltas.push(delta));

      expect(deltas).toEqual(['我坐', ' 3 号，', '先听前面的。']);
      expect(full).toEqual({ content: '我坐 3 号，先听前面的。' });
    });

    it('不传回调就不下发 stream，走的还是一次收完', async () => {
      const { send, sent } = fakeSend(200, answer('好'));

      await openaiModelPort({ fetch: send }).generate(REQUEST, ACCESS);

      expect(bodyOf(sent)).not.toHaveProperty('stream');
    });

    it('吐到一半断了，错上标着已经吐过字', async () => {
      const port = openaiModelPort({ fetch: sseThenDie('半句') });
      const deltas: string[] = [];

      const error = await streamFailureOf(port, deltas);

      expect(deltas).toEqual(['半句']);
      expect(error.code).toBe('transient');
      // 这半句调用方已经拿到手了，重发就是把两段话接在一起。
      expect(error.partialOutput).toBe(true);
    });

    it('成了流又一个字没吐就断，归 transient', async () => {
      const port = openaiModelPort({ fetch: sseDieBeforeContent() });
      const deltas: string[] = [];

      const error = await streamFailureOf(port, deltas);

      expect(deltas).toEqual([]);
      expect(error.code).toBe('transient');
      // 一个字都没交出去，重发是干净的。
      expect(error.partialOutput).toBe(false);
    });

    it('流里一个字的正文都没来，也归 transient', async () => {
      const port = openaiModelPort({ fetch: sseSend() });

      expect((await streamFailureOf(port, [])).code).toBe('transient');
    });

    it('流里只有空白分片，也算吐过字了，重发会接在它后面', async () => {
      const port = openaiModelPort({ fetch: sseSend('\n', '  ') });
      const deltas: string[] = [];

      const error = await streamFailureOf(port, deltas);

      expect(deltas).toEqual(['\n', '  ']);
      expect(error.code).toBe('transient');
      // 一个字有用的都没有，但调用方手里确实已经拿到一段了。
      expect(error.partialOutput).toBe(true);
    });

    it('分片里没有 choices 键也接着往下读', async () => {
      // 有些网关会推一段只有 usage 的分片，SDK 原样交出来，choices 是 undefined。
      const body =
        `data: ${JSON.stringify({ usage: { prompt_tokens: 3 } })}\n\n` +
        chunkOf('我坐') +
        'data: [DONE]\n\n';
      const send: SendRequest = async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

      const deltas: string[] = [];
      const full = await openaiModelPort({ fetch: send }).generate(REQUEST, ACCESS, (delta) =>
        deltas.push(delta),
      );

      expect(deltas).toEqual(['我坐']);
      expect(full).toEqual({ content: '我坐' });
    });

    it('流还没成、HTTP 那一层就拒了，照常按状态码归类', async () => {
      const error = await streamFailureOf(openaiModelPort({ fetch: refusedStream() }), []);

      // 这一条盯的是 create() 那一层的归类：还没成流，状态码和响应头都还在手上。
      expect(error.code).toBe('transient');
      expect(error.retryAfterMs).toBe(2000);
    });
  });

  describe('失败归类', () => {
    it.each<[number, string]>([
      [408, 'transient'],
      [429, 'transient'],
      [500, 'transient'],
      [502, 'transient'],
      [400, 'fatal'],
      [401, 'fatal'],
      [403, 'fatal'],
      [404, 'fatal'],
    ])('状态码 %i 归为 %s', async (status, code) => {
      const port = openaiModelPort({ fetch: fakeSend(status, '拒绝了').send });

      const error = await failureOf(port);

      expect(error).toBeInstanceOf(ModelCallError);
      expect(error.code).toBe(code);
      expect(error.message).toContain(`返回 ${status}`);
    });

    it.each(['AccountQuotaExceeded', 'QuotaExceeded', 'insufficient_quota', 'quota_exhausted'])(
      '限流报文里写着 %s 就归 fatal，再试也是一样',
      async (code) => {
        const port = openaiModelPort({
          fetch: fakeSend(429, JSON.stringify({ error: { code } })).send,
        });

        expect((await failureOf(port)).code).toBe('fatal');
      },
    );

    it('限流报文里没提配额，就还是 transient', async () => {
      const port = openaiModelPort({
        fetch: fakeSend(429, JSON.stringify({ error: { code: 'RateLimitExceeded' } })).send,
      });

      expect((await failureOf(port)).code).toBe('transient');
    });

    it('端点写了让等多久，就把它带在错上', async () => {
      const port = openaiModelPort({
        fetch: fakeSend(429, JSON.stringify({ error: { code: 'RateLimitExceeded' } }), {
          'retry-after': '3',
        }).send,
      });

      // 端点要的冷却窗口是 3 秒，比退避算出来的长：交给重试那一层去听。
      expect((await failureOf(port)).retryAfterMs).toBe(3000);
    });

    it('端点没写让等多久，错上就不带这个字段', async () => {
      const port = openaiModelPort({
        fetch: fakeSend(503, JSON.stringify({ error: { code: 'ServerOverloaded' } })).send,
      });

      expect((await failureOf(port)).retryAfterMs).toBeUndefined();
    });

    it('连不上归 transient，原始错误在 cause 链的第二层', async () => {
      const cause = new Error('connect ECONNREFUSED 127.0.0.1:443');
      const error = await failureOf(openaiModelPort({ fetch: failingSend(cause) }));

      expect(error.code).toBe('transient');
      // SDK 中间裹了一层，它自己那句只有通用的 Connection error.，原始错在它底下。
      expect((error.cause as Error).cause).toBe(cause);
    });

    it('正文不是 JSON 时，报文原文仍然进判定：纯文本的配额用尽照样归 fatal', async () => {
      // 限流说明和网关拦下来的页面都可能是纯文本，SDK 不解析这种体，整段塞在 message 里。
      const port = openaiModelPort({
        fetch: fakeSend(429, 'insufficient_quota: your balance is 0', {
          'content-type': 'text/plain',
        }).send,
      });

      const error = await failureOf(port);

      // 只看 error 和 code 两个字段的话，这条会被当成限流白重试三次。
      expect(error.code).toBe('fatal');
      expect(error.message).toContain('insufficient_quota');
    });

    it('5xx 的正文不是 JSON 时，网关那段说明也留得下来', async () => {
      const port = openaiModelPort({
        fetch: fakeSend(502, '<html>upstream connect error</html>', {
          'content-type': 'text/html',
        }).send,
      });

      const error = await failureOf(port);

      expect(error.code).toBe('transient');
      expect(error.message).toContain('upstream connect error');
    });

    it('正文读到一半断了，交出来的是裸 Error，这一层不替它猜', async () => {
      const error = await openaiModelPort({ fetch: cutOffSend(200) })
        .generate(REQUEST, ACCESS)
        .catch((thrown: unknown) => thrown);

      // 自己拼 HTTP 那会儿这一条归 transient，走 SDK 之后归不了：SDK 没把它包成 APIError，
      // 光看一个 Error 分不清「连接断了」和「代码自己写错了」，硬猜就又回到嗅探老路上了。
      expect(error).not.toBeInstanceOf(ModelCallError);
      expect((error as Error).message).toContain('socket hang up');
    });

    it('状态码说不行，正文又没读回来，还是按状态码归类', async () => {
      const error = await failureOf(openaiModelPort({ fetch: cutOffSend(401) }));

      // 一律翻成 transient 会把「密钥写错了」盖成网络抖动，重试三次再报一句「都没成」。
      expect(error.code).toBe('fatal');
      expect(error.message).toContain('返回 401');
    });

    it('5xx 且正文没读回来，读不回来这件事不改它的归类', async () => {
      const error = await failureOf(openaiModelPort({ fetch: cutOffSend(500) }));

      // 这一条盯着「非 ok 就一律 fatal」那种写法：状态码是 500 时还得是 transient。
      expect(error.code).toBe('transient');
      expect(error.message).toContain('返回 500');
    });

    it('答复不是 JSON 归 transient，重发一次还有戏', async () => {
      // 网关拦下来的时候就是这么答的：状态 200，正文是它自己的 HTML。
      const port = openaiModelPort({
        fetch: fakeSend(200, '<html>网关</html>', { 'content-type': 'text/html' }).send,
      });

      const error = await failureOf(port);

      // 这跟网络抖一下是一回事：这次没拿到，不是模型答得不合规。
      expect(error.code).toBe('transient');
      // 网关塞的那段原文得留在报错里，不然只看得见一句「不合结构」。
      expect(error.message).toContain('<html>网关</html>');
    });

    it('头里写着 JSON、正文又不是 JSON，照样归 transient', async () => {
      // 网关答错页时 content-type 未必老实填。填了 JSON 的话是 SDK 自己去 JSON.parse，
      // 抛出来的是裸 SyntaxError，带不进 APIError，不在端口里接住就会一路穿过重试层。
      const port = openaiModelPort({
        fetch: fakeSend(200, '<html>网关</html>', { 'content-type': 'application/json' }).send,
      });

      const error = await failureOf(port);

      expect(error.code).toBe('transient');
      expect(error.message).toContain('不是合法 JSON');
    });

    it('答复是 JSON 但 choices 是空的，也归 transient', async () => {
      const port = openaiModelPort({ fetch: fakeSend(200, JSON.stringify({ choices: [] })).send });

      expect((await failureOf(port)).code).toBe('transient');
    });

    it('正文是空的，也归 transient', async () => {
      const port = openaiModelPort({ fetch: fakeSend(200, answer('   ')).send });

      expect((await failureOf(port)).code).toBe('transient');
    });
  });
});
