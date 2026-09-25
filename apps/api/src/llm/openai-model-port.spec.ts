import { openaiModelPort, type SendRequest } from './openai-model-port';
import {
  ModelCallError,
  type ModelAccess,
  type ModelCallOptions,
  type StreamDelta,
} from './model-port';

const BASE_URL = 'https://model.example.test/v1';

// 密钥得是 ASCII：SDK 把它塞进 HTTP 头，而头只收字节串。
const ACCESS: ModelAccess = {
  baseUrl: BASE_URL,
  model: '用例模型',
  apiKey: 'sk-test',
  capability: { reasoningOff: { thinking: { type: 'disabled' } } },
};

const REQUEST = { system: '你是谁', prompt: '要你做什么' };

it('完整答复在请求开销写入之前同步通知，写入完成前仍不结束调用', async () => {
  const port = openaiModelPort({ fetch: fakeSend(200, answer('已收到')).send });
  const order: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writing!: () => void;
  const started = new Promise<void>((resolve) => {
    writing = resolve;
  });
  const running = port.generate(REQUEST, ACCESS, {
    onResponse: (response) => {
      order.push(response.content);
    },
    startAttempt: async () => ({
      dispatched() {},
      async finish() {
        order.push('开始记账');
        writing();
        await blocked;
        order.push('记账完成');
      },
    }),
  });
  await started;
  expect(order).toEqual(['已收到', '开始记账']);
  release();
  await running;
  expect(order).toEqual(['已收到', '开始记账', '记账完成']);
});

/** 答复正文包成 OpenAI 那种形状。 */
function answer(content: string): string {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
}

/** 带思考那一段的答复。思考与正文是两条通道，走不走工具都可能带着它。 */
function thinkingAnswer(content: string, reasoning: string): string {
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content, reasoning_content: reasoning } }],
  });
}

/** 走工具交答案的答复：正文是空串，答案在 tool_calls 那一头。实测真端点交出来的就是这个样子。 */
function toolAnswer(name: string, args: string): string {
  return JSON.stringify({
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name, arguments: args } }],
        },
      },
    ],
  });
}

const TOOL = { name: 'submit', description: '交这次的答案', parameters: { type: 'object' } };

/** 推出来的每一段正文。只看正文那一头的用例看它，思考那一路不算在里头。 */
function textsOf(deltas: readonly StreamDelta[]): string[] {
  return deltas.filter((one) => one.channel === 'content').map((one) => one.text);
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
function chunkOf(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const chunk = {
    id: 'x',
    object: 'chat.completion.chunk',
    created: 0,
    model: '用例模型',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** 正文那一片。 */
function said(text: string): string {
  return chunkOf({ content: text });
}

/** 思考那一片：跟正文是两条通道，走不走工具都可能带着它。 */
function thought(text: string): string {
  return chunkOf({ reasoning_content: text });
}

/** 工具参数那一片：头一片带着工具名，之后每片只续参数。 */
function calling(args: string, name?: string): string {
  return chunkOf({
    tool_calls: [
      { index: 0, function: name === undefined ? { arguments: args } : { name, arguments: args } },
    ],
  });
}

/** 一段流式的正文：给什么片就推什么片，收尾带上 [DONE]。 */
function sseBody(...pieces: string[]): string {
  const reason = pieces.some((piece) => piece.includes('tool_calls')) ? 'tool_calls' : 'stop';
  return pieces.join('') + chunkOf({}, reason) + 'data: [DONE]\n\n';
}

/** 造一段正常的流式答复。 */
function sseSend(...pieces: string[]): SendRequest {
  const body = sseBody(...pieces);
  return async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * 造一段吐到一半就断的流。
 * 分片得先真的交出去，断的那一下才算「已经吐过字」，所以用 pull 一片一片地给，
 * 等读的人要下一片时才断。
 */
function sseThenDie(text: string): SendRequest {
  const chunk = new TextEncoder().encode(said(text));
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

/** 造一段头已经到了、正文再也不会结束的流：吐了一片就停在那儿，收不到 [DONE]。 */
function sseNeverEnds(text: string): SendRequest {
  const chunk = new TextEncoder().encode(said(text));
  return async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
}

/**
 * 造一段被中止时当场报错的流：吐过一片之后，等到底层那次读被中止才把错误抛出来。
 * 真网络里读到一半被中止走的就是这条：读的人拿到的是中止本身，不是「流正常结束」。
 */
function sseDiesOnAbort(text: string): SendRequest {
  const chunk = new TextEncoder().encode(said(text));
  return async (_url, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          init?.signal?.addEventListener('abort', () =>
            controller.error(new Error('read aborted')),
          );
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
async function failureOf(port: ReturnType<typeof openaiModelPort>, call?: ModelCallOptions) {
  try {
    await port.generate(REQUEST, ACCESS, call);
  } catch (error) {
    return error as ModelCallError;
  }
  throw new Error('本该抛错');
}

describe('OpenAI 兼容模型端口', () => {
  it.each(['length', 'content_filter'])('非流式也拒绝被 %s 截断的正文', async (reason) => {
    const { send } = fakeSend(
      200,
      JSON.stringify({
        choices: [
          {
            message: { content: '还没说完' },
            finish_reason: reason,
          },
        ],
      }),
    );
    await expect(openaiModelPort({ fetch: send }).generate(REQUEST, ACCESS)).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });

  describe('正常收发', () => {
    it('取第一条 choice 的正文交出去', async () => {
      const { send } = fakeSend(200, answer('我坐 3 号，先听前面的。'));

      await expect(openaiModelPort({ fetch: send }).generate(REQUEST, ACCESS)).resolves.toEqual({
        content: '我坐 3 号，先听前面的。',
        toolCall: null,
        reasoning: null,
      });
    });

    it('端点交回思考那一段就原样取出来，没给就是 null', async () => {
      const withThinking = fakeSend(200, thinkingAnswer('守 3 号。', '5 号昨夜守过，不能连守。'));
      await expect(
        openaiModelPort({ fetch: withThinking.send }).generate(REQUEST, ACCESS),
      ).resolves.toEqual({
        content: '守 3 号。',
        toolCall: null,
        reasoning: '5 号昨夜守过，不能连守。',
      });

      const without = fakeSend(200, answer('守 3 号。'));
      await expect(
        openaiModelPort({ fetch: without.send }).generate(REQUEST, ACCESS),
      ).resolves.toMatchObject({ reasoning: null });
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

    it('只提供一个工具并用 required 提交，兼容开启思考的 Kimi', async () => {
      const { send, sent } = fakeSend(200, toolAnswer('submit', '{"targetId":"p2"}'));

      await openaiModelPort({ fetch: send }).generate({ ...REQUEST, tool: TOOL }, ACCESS);

      expect(bodyOf(sent)).toMatchObject({
        tools: [
          {
            type: 'function',
            function: {
              name: 'submit',
              description: '交这次的答案',
              parameters: { type: 'object' },
            },
          },
        ],
        tool_choice: 'required',
      });
    });

    it.each([false, true])('不接受强制工具的端点按声明使用 auto，流式=%s', async (streaming) => {
      const { send, sent } = fakeSend(
        200,
        streaming
          ? sseBody(calling('{"value":true}', 'submit'))
          : toolAnswer('submit', '{"value":true}'),
        streaming ? { 'content-type': 'text/event-stream' } : {},
      );
      const capability = { reasoningOff: null, toolChoice: 'auto' as const };

      const result = await openaiModelPort({ fetch: send }).generate(
        { ...REQUEST, tool: TOOL },
        { ...ACCESS, capability },
        streaming ? { onDelta: () => undefined } : {},
      );

      expect(bodyOf(sent)).toMatchObject({ tool_choice: 'auto' });
      expect(bodyOf(sent)).not.toHaveProperty('thinking');
      expect(result.toolCall).toEqual({ name: 'submit', arguments: '{"value":true}' });
    });

    it.each([false, true])(
      '严格工具模式处理嵌套约束且不修改原 schema，流式=%s',
      async (streaming) => {
        const { send, sent } = fakeSend(
          200,
          streaming
            ? sseBody(calling('{"value":true}', 'submit'))
            : toolAnswer('submit', '{"value":true}'),
          streaming ? { 'content-type': 'text/event-stream' } : {},
        );
        const parameters = {
          type: 'object',
          properties: {
            minLength: { type: 'string', minLength: 1, maxLength: 30 },
            refs: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string', minLength: 1 },
            },
          },
          required: ['minLength', 'refs'],
          additionalProperties: false,
        };
        const original = structuredClone(parameters);
        const tool = { ...TOOL, parameters };
        const port = openaiModelPort({ fetch: send });
        const call = streaming ? { onDelta: () => undefined } : {};
        await port.generate(
          { ...REQUEST, tool },
          { ...ACCESS, capability: { reasoningOff: null, toolStrict: true } },
          call,
        );
        expect(bodyOf(sent)).toMatchObject({
          tools: [
            {
              function: {
                strict: true,
                parameters: {
                  ...parameters,
                  properties: {
                    minLength: { type: 'string' },
                    refs: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          ],
        });
        expect(parameters).toEqual(original);
        sent.length = 0;
        await port.generate({ ...REQUEST, tool }, ACCESS, call);
        expect(bodyOf(sent)).toMatchObject({ tools: [{ function: { parameters: original } }] });
        expect(
          (bodyOf(sent) as { tools: { function: object }[] }).tools[0]!.function,
        ).not.toHaveProperty('strict');
      },
    );

    it('走工具时答案从 tool_calls 取，正文空着也不算这次没拿到', async () => {
      const { send } = fakeSend(200, toolAnswer('submit', '{"targetId":"p2"}'));

      await expect(
        openaiModelPort({ fetch: send }).generate({ ...REQUEST, tool: TOOL }, ACCESS),
      ).resolves.toEqual({
        content: '',
        toolCall: { name: 'submit', arguments: '{"targetId":"p2"}' },
        reasoning: null,
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

    it('能力里没给关思维链的片段就不带它，不给工具也不塞结构化约束', async () => {
      const { send, sent } = fakeSend(200, answer('好'));

      await openaiModelPort({ fetch: send }).generate(REQUEST, {
        ...ACCESS,
        capability: { reasoningOff: null },
      });

      // 发言那几问要的就是一段自然语言：端口不自己发 response_format，也不塞一个默认工具进去。
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

    it('超时按截止时间中止请求，归 transient', async () => {
      const sent: Sent[] = [];
      // 一直不回，只有截止时间能把它中止掉：超时时间没接上的话这个用例会挂在这儿。
      const hanging: SendRequest = (url, init) => {
        sent.push({ url: String(url), init });
        return new Promise<Response>((_done, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      };

      const error = await failureOf(openaiModelPort({ fetch: hanging, timeoutMs: 20 }));

      // 单次调用的上限归 transient：端点这次排得久、下次未必，重发一次还有戏；
      // 往上那一层据此决定要不要重发。
      expect(error.code).toBe('transient');
      // 一个字都没拿到，重发是干净的。
      expect(error.partialOutput).toBe(false);
      expect(sent[0]?.init?.signal?.aborted).toBe(true);
    });

    it('调用方已经喊停，一个请求都不发', async () => {
      const { send, sent } = fakeSend(200, answer('好'));

      const error = await failureOf(openaiModelPort({ fetch: send }), {
        signal: AbortSignal.abort(),
      });

      expect(error.code).toBe('deadline');
      expect(sent).toHaveLength(0);
    });
  });

  describe('流式', () => {
    it.each(['', 'data: [DONE]\n\n'])('缺少结束原因时不把半句正文当作成功：%s', async (ending) => {
      const { send } = fakeSend(200, said('还没说完') + ending, {
        'content-type': 'text/event-stream',
      });
      await expect(
        openaiModelPort({ fetch: send }).generate(REQUEST, ACCESS, { onDelta: () => {} }),
      ).rejects.toMatchObject({ code: 'transient', partialOutput: true });
    });

    it.each(['length', 'content_filter'])('拒绝被 %s 截断的输出', async (reason) => {
      const { send } = fakeSend(200, said('半句话') + chunkOf({}, reason) + 'data: [DONE]\n\n', {
        'content-type': 'text/event-stream',
      });
      await expect(
        openaiModelPort({ fetch: send }).generate(REQUEST, ACCESS, { onDelta: () => {} }),
      ).rejects.toMatchObject({ code: 'invalid_output' });
    });

    /**
     * 跑一次流式，把抛出来的分类取回来；没抛就是用例自己写错了。
     * 收到每一段先记进 deltas，再交给用例自己的回调——要趁着吐字的那一下喊停的用例靠它。
     */
    async function streamFailureOf(
      port: ReturnType<typeof openaiModelPort>,
      deltas: StreamDelta[],
      call: ModelCallOptions = {},
    ) {
      const { onDelta } = call;
      try {
        await port.generate(REQUEST, ACCESS, {
          ...call,
          onDelta: (delta) => {
            deltas.push(delta);
            onDelta?.(delta);
          },
        });
      } catch (error) {
        return error as ModelCallError;
      }
      throw new Error('本该抛错');
    }

    it('收到一段交出去一段，返回值是拼起来的全文', async () => {
      const port = openaiModelPort({
        fetch: sseSend(said('我坐'), said(' 3 号，'), said('先听前面的。')),
      });
      const deltas: StreamDelta[] = [];

      const full = await port.generate(REQUEST, ACCESS, {
        onDelta: (delta) => deltas.push(delta),
      });

      // 交出去的是到目前写成的全文而不是增量：丢一段、乱序一段都不影响那头照着替换。
      expect(deltas).toEqual([
        { channel: 'content', text: '我坐' },
        { channel: 'content', text: '我坐 3 号，' },
        { channel: 'content', text: '我坐 3 号，先听前面的。' },
      ]);
      expect(full).toEqual({ content: '我坐 3 号，先听前面的。', toolCall: null, reasoning: null });
    });

    it('思考与正文各走各的通道，互不搅在一起', async () => {
      const port = openaiModelPort({
        fetch: sseSend(thought('3 号'), thought('有点急。'), said('我坐 3 号。')),
      });
      const deltas: StreamDelta[] = [];

      await port.generate(REQUEST, ACCESS, { onDelta: (delta) => deltas.push(delta) });

      expect(deltas).toEqual([
        { channel: 'reasoning', text: '3 号', thinkingMs: expect.any(Number) },
        { channel: 'reasoning', text: '3 号有点急。', thinkingMs: expect.any(Number) },
        { channel: 'content', text: '我坐 3 号。', thinkingMs: expect.any(Number) },
      ]);
    });

    it.each([false, true])('推理计时在正文或工具参数开始时停止，工具=%s', async (tool) => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
      const port = openaiModelPort({
        fetch: sseSend(
          thought('思考'),
          tool ? calling('{"value":', 'submit') : said('答案'),
          tool ? calling('true}') : said('正文继续'),
        ),
      });
      try {
        const full = await port.generate(tool ? { ...REQUEST, tool: TOOL } : REQUEST, ACCESS, {
          onDelta: (delta) => {
            clock.mockReturnValue(delta.channel === 'reasoning' ? 4000 : 9000);
          },
        });
        expect(full.thinkingMs).toBe(3000);
      } finally {
        clock.mockRestore();
      }
    });

    it('走工具也照样能流：正文那一头一片都没有，也不报「正文是空的」', async () => {
      const { send, sent } = fakeSend(200, sseBody(calling('{}', 'submit')), {
        'content-type': 'text/event-stream',
      });
      const deltas: StreamDelta[] = [];

      const full = await openaiModelPort({ fetch: send }).generate(
        { ...REQUEST, tool: TOOL },
        ACCESS,
        { onDelta: (delta) => deltas.push(delta) },
      );

      // 流式与工具不是互斥的两条路：这一问照样走流，只是正文那一头本来就是空的。
      expect(bodyOf(sent)).toHaveProperty('stream', true);
      expect(deltas).toEqual([]);
      // 正文空着本来就该算数，拦下来只会白重试三次还是同一个结果。
      expect(full).toEqual({
        content: '',
        toolCall: { name: 'submit', arguments: '{}' },
        reasoning: null,
      });
    });

    it('带工具的流里，思考在工具参数之前到，推得出去', async () => {
      const port = openaiModelPort({
        fetch: sseSend(thought('先查 3 号。'), calling('{"seatNo"', 'submit'), calling(':3}')),
      });
      const deltas: StreamDelta[] = [];

      const full = await port.generate({ ...REQUEST, tool: TOOL }, ACCESS, {
        onDelta: (delta) => deltas.push(delta),
      });

      // 工具参数拼到收尾才交出去，中途不往外推：半截 JSON 没有可读的东西。
      expect(deltas).toEqual([
        { channel: 'reasoning', text: '先查 3 号。', thinkingMs: expect.any(Number) },
      ]);
      expect(full).toEqual({
        content: '',
        toolCall: { name: 'submit', arguments: '{"seatNo":3}' },
        reasoning: '先查 3 号。',
        thinkingMs: expect.any(Number),
      });
    });

    it('带工具的流里只有工具参数，不报「正文是空的」', async () => {
      const port = openaiModelPort({ fetch: sseSend(calling('{}', 'submit')) });

      const full = await port.generate({ ...REQUEST, tool: TOOL }, ACCESS, { onDelta: () => {} });

      // 正文空着本来就该算数：答案在参数那一头，拦下来只会白重试三次还是同一个结果。
      expect(full).toEqual({
        content: '',
        toolCall: { name: 'submit', arguments: '{}' },
        reasoning: null,
      });
    });

    it('带工具的流里工具参数一片都没来，归 transient', async () => {
      const port = openaiModelPort({ fetch: sseSend(thought('想好了。')) });

      const error = await streamFailureOf(port, [], {});
      expect(error.code).toBe('transient');
    });

    it('拼出来的工具参数与一次收完那条路径对同一份报文一致', async () => {
      const args = '{"seatNo":3,"reason":"先听前面的"}';
      const port = openaiModelPort({
        fetch: sseSend(
          calling('{"seatNo"', 'submit'),
          calling(':3,"reason":"先听'),
          calling('前面的"}'),
        ),
      });

      const streamed = await port.generate({ ...REQUEST, tool: TOOL }, ACCESS, {
        onDelta: () => {},
      });
      const whole = await openaiModelPort({
        fetch: fakeSend(200, toolAnswer('submit', args)).send,
      }).generate({ ...REQUEST, tool: TOOL }, ACCESS);

      expect(streamed).toEqual(whole);
      expect(streamed.toolCall).toEqual({ name: 'submit', arguments: args });
    });

    it('不传回调就不下发 stream，走的还是一次收完', async () => {
      const { send, sent } = fakeSend(200, answer('好'));

      await openaiModelPort({ fetch: send }).generate(REQUEST, ACCESS);

      expect(bodyOf(sent)).not.toHaveProperty('stream');
    });

    it('吐到一半断了，错上标着已经吐过字', async () => {
      const port = openaiModelPort({ fetch: sseThenDie('半句') });
      const deltas: StreamDelta[] = [];

      const error = await streamFailureOf(port, deltas);

      expect(textsOf(deltas)).toEqual(['半句']);
      expect(error.code).toBe('transient');
      // 这半句调用方已经拿到手了，重发就是把两段话接在一起。
      expect(error.partialOutput).toBe(true);
    });

    it('成了流又一个字没吐就断，归 transient', async () => {
      const port = openaiModelPort({ fetch: sseDieBeforeContent() });
      const deltas: StreamDelta[] = [];

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
      const port = openaiModelPort({ fetch: sseSend(said('\n'), said('  ')) });
      const deltas: StreamDelta[] = [];

      const error = await streamFailureOf(port, deltas);

      expect(textsOf(deltas)).toEqual(['\n', '\n  ']);
      expect(error.code).toBe('transient');
      // 一个字有用的都没有，但调用方手里确实已经拿到一段了。
      expect(error.partialOutput).toBe(true);
    });

    it('分片里没有 choices 键也接着往下读', async () => {
      // 有些网关会推一段只有 usage 的分片，SDK 原样交出来，choices 是 undefined。
      const body = sseBody(
        `data: ${JSON.stringify({ usage: { prompt_tokens: 3 } })}\n\n`,
        said('我坐'),
      );
      const send: SendRequest = async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

      const deltas: StreamDelta[] = [];
      const full = await openaiModelPort({ fetch: send }).generate(REQUEST, ACCESS, {
        onDelta: (delta) => deltas.push(delta),
      });

      expect(textsOf(deltas)).toEqual(['我坐']);
      expect(full).toEqual({ content: '我坐', toolCall: null, reasoning: null });
    });

    it('流还没成、HTTP 那一层就拒了，照常按状态码归类', async () => {
      const error = await streamFailureOf(openaiModelPort({ fetch: refusedStream() }), []);

      // 这一条盯的是 create() 那一层的归类：还没成流，状态码和响应头都还在手上。
      expect(error.code).toBe('transient');
      expect(error.retryAfterMs).toBe(2000);
    });

    it('正文拖着不结束，到截止时间当场中止', async () => {
      const port = openaiModelPort({ fetch: sseNeverEnds('我坐'), timeoutMs: 20 });
      const deltas: StreamDelta[] = [];

      const error = await streamFailureOf(port, deltas);

      // 头早就到了、字也在往外吐，超时要是只算到响应头，这个用例会一直挂在这儿。
      expect(error.code).toBe('transient');
      // 中止时 SDK 是把迭代就地收尾，不抛错：这条不拦就会当成「答到一半就结束了」的正常答复。
      expect(error.message).toContain('超时');
      // 已经交出去的那半句调用方拿到手了，重发得另做打算。
      expect(textsOf(deltas)).toEqual(['我坐']);
      expect(error.partialOutput).toBe(true);
    });

    it('流到一半调用方喊停，归 deadline 而不是「读到一半断了」', async () => {
      const stopping = new AbortController();
      const deltas: StreamDelta[] = [];

      const error = await streamFailureOf(
        openaiModelPort({ fetch: sseNeverEnds('我坐') }),
        deltas,
        { signal: stopping.signal, onDelta: () => stopping.abort() },
      );

      // 被喊停的流和半路断掉的流长得一样，判据只能取信号：分不清就会被当成「这次没读完」，重发一遍。
      expect(error.code).toBe('deadline');
      expect(textsOf(deltas)).toEqual(['我坐']);
    });

    it('中止是以读报错的形式冒出来的，也归 deadline', async () => {
      const stopping = new AbortController();
      const deltas: StreamDelta[] = [];

      const pending = streamFailureOf(openaiModelPort({ fetch: sseDiesOnAbort('我坐') }), deltas, {
        signal: stopping.signal,
      });
      // 停在正读着的那一下上喊停：那一次读是被中止顶回来的，不是流自己走完的。
      setTimeout(() => stopping.abort(), 20);

      const error = await pending;

      expect(error.code).toBe('deadline');
      expect(error.message).toContain('被中止');
      expect(error.partialOutput).toBe(true);
      expect(textsOf(deltas)).toEqual(['我坐']);
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

    it('工具参数是空的，也归 transient', async () => {
      const port = openaiModelPort({ fetch: fakeSend(200, toolAnswer('submit', '')).send });

      const error = await failureOf(port);

      // 空串交到调用方那儿会被读成「不是合法 JSON」，问它要个说法也问不出新东西，白重问两遍。
      expect(error.code).toBe('transient');
      expect(error.message).toContain('工具参数是空的');
    });
  });
});
