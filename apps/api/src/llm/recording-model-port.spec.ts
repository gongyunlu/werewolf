import {
  ModelCallError,
  type ModelAccess,
  type ModelCallOptions,
  type ModelPort,
} from './model-port';
import { recordingModelPort, type AskedPrompt } from './recording-model-port';
import { retryingModelPort } from './retrying-model-port';

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-用例',
  capability: { reasoningOff: null },
};

const REQUEST = { system: '你是谁', prompt: '要你做什么' };

/** 一个只记下自己被问过什么的端口替身。 */
function innerPort(sent: string[]): ModelPort {
  return {
    generate(request) {
      sent.push(request.prompt);
      return Promise.resolve({ content: '好', toolCall: null, reasoning: null });
    },
  };
}

describe('记提问的端口', () => {
  it('先把这份提问落下来，再往外发', async () => {
    const steps: string[] = [];
    const asked: AskedPrompt[] = [];
    const tool = { name: 'submit', description: '交这一问的答案', parameters: { type: 'object' } };
    const port = recordingModelPort(innerPort(steps), (saved) => {
      steps.push('落');
      asked.push(saved);
      return Promise.resolve();
    });

    const response = await port.generate({ ...REQUEST, tool }, ACCESS);

    // 顺序反过来的话，崩在发出去那一刻的这一问就什么也没留下——那样这一层就白加了。
    expect(steps).toEqual(['落', '要你做什么']);
    expect(asked).toEqual([{ model: ACCESS.model, system: '你是谁', prompt: '要你做什么', tool }]);
    // 落在题面上的只有这四项；密钥在接入身份那一头，不该跟着题面一起进库。
    expect(JSON.stringify(asked)).not.toContain(ACCESS.apiKey);
    expect(response).toEqual({ content: '好', toolCall: null, reasoning: null });
  });

  it('落不下来就当场抛，这一问不再发出去', async () => {
    const sent: string[] = [];
    const failure = new Error('库写不进去');
    const port = recordingModelPort(innerPort(sent), () => Promise.reject(failure));

    await expect(port.generate(REQUEST, ACCESS)).rejects.toBe(failure);
    expect(sent).toHaveLength(0);
  });

  it('端口重发的那几次不另记：重发的是同一份题面', async () => {
    const rows: AskedPrompt[] = [];
    let sends = 0;
    const inner: ModelPort = {
      generate() {
        sends += 1;
        if (sends === 1) throw new ModelCallError('transient', '端点打了个嗝');
        return Promise.resolve({ content: '好', toolCall: null, reasoning: null });
      },
    };
    // 按生产里的包法组一遍：记录层在重试层外面，见 turn/provider 的 logged。
    const port = recordingModelPort(
      retryingModelPort(inner, { attempts: 3, backoffMs: 0, random: () => 0 }),
      (saved) => {
        rows.push(saved);
        return Promise.resolve();
      },
    );

    expect((await port.generate(REQUEST, ACCESS)).content).toBe('好');

    // 两层包反了照样跑得通，只是这一问会落成好几行——这一条钉的就是那个包法。
    expect(sends).toBe(2);
    expect(rows).toHaveLength(1);
  });

  it('没走工具的那几问落下来的提问里没有工具，调用口子照旧传下去', async () => {
    const asked: AskedPrompt[] = [];
    const calls: (ModelCallOptions | undefined)[] = [];
    const options: ModelCallOptions = { signal: new AbortController().signal };
    const port = recordingModelPort(
      {
        generate(_request, _access, call) {
          calls.push(call);
          return Promise.resolve({ content: '我过。', toolCall: null, reasoning: null });
        },
      },
      (saved) => {
        asked.push(saved);
        return Promise.resolve();
      },
    );

    expect((await port.generate(REQUEST, ACCESS, options)).content).toBe('我过。');

    // 发言那一问是不给工具的（见 provider 的 speech），落下来就该是空的。
    expect(asked[0]?.tool).toBeUndefined();
    // 流式、超时、中止这三样都靠这个口子递下去，这一层不能吞掉也不能另拼一份。
    expect(calls[0]).toBe(options);
  });
});
