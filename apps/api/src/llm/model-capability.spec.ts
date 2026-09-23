import { endpointOf, resolveModelCapability } from './model-capability';

const ENDPOINT = 'https://model.example.test/v1';
const MODEL = '用例模型';

/** 环境变量里那份声明的写法，用例里按需拼。 */
function declarations(...entries: readonly object[]): string {
  return JSON.stringify(entries);
}

/** 一条对得上的声明，只改要验的那一项。 */
function declared(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseUrl: ENDPOINT,
    model: MODEL,
    reasoningOff: null,
    ...overrides,
  };
}

describe('模型能力', () => {
  describe('端点归一', () => {
    it('末尾斜杠、大小写、默认端口都归成一种写法', () => {
      expect(endpointOf('https://model.example.test/v1/')).toBe('https://model.example.test/v1');
      expect(endpointOf('HTTPS://Model.Example.Test/v1')).toBe('https://model.example.test/v1');
      expect(endpointOf('https://model.example.test:443/v1')).toBe('https://model.example.test/v1');
    });
  });

  describe('按端点加型号取能力', () => {
    it('保留端点声明的工具选择方式', () => {
      expect(
        resolveModelCapability(MODEL, ENDPOINT, declarations(declared({ toolChoice: 'auto' }))),
      ).toEqual({
        reasoningOff: null,
        toolChoice: 'auto',
      });
    });
    it('声明过的按声明取，关思维链的片段原样带出来', () => {
      const text = declarations(declared({ reasoningOff: { thinking: { type: 'disabled' } } }));

      expect(resolveModelCapability(MODEL, ENDPOINT, text)).toEqual({
        reasoningOff: { thinking: { type: 'disabled' } },
      });
    });

    it('没给这个开关的型号，带出来是 null', () => {
      expect(resolveModelCapability(MODEL, ENDPOINT, declarations(declared()))).toEqual({
        reasoningOff: null,
      });
    });

    it('端点写法不同不影响命中', () => {
      const text = declarations(declared({ reasoningOff: { thinking: { type: 'disabled' } } }));

      expect(resolveModelCapability(MODEL, `${ENDPOINT}/`, text)).toEqual({
        reasoningOff: { thinking: { type: 'disabled' } },
      });
    });

    it('型号或端点对不上就抛错，不拿相近的顶', () => {
      const text = declarations(declared());

      expect(() => resolveModelCapability('没见过的型号', ENDPOINT, text)).toThrow(
        '未声明该端点与模型的能力',
      );
      // 同一个型号换个端点也不认：不同网关上的收法本来就不一样。
      expect(() => resolveModelCapability(MODEL, 'https://other.test/v1', text)).toThrow(
        '未声明该端点与模型的能力',
      );
    });

    it('空串按没配处理，一样抛', () => {
      expect(() => resolveModelCapability(MODEL, ENDPOINT, '')).toThrow('未声明该端点与模型的能力');
    });
  });

  describe('声明本身写错了', () => {
    it('同一个端点同一个型号声明两遍，当场抛', () => {
      const twice = declarations(declared(), declared({ baseUrl: `${ENDPOINT}/` }));

      expect(() => resolveModelCapability(MODEL, ENDPOINT, twice)).toThrow('模型能力声明重复');
    });

    it('缺字段是配置写错了，当场抛', () => {
      const broken = declarations({ baseUrl: ENDPOINT, model: MODEL });

      expect(() => resolveModelCapability(MODEL, ENDPOINT, broken)).toThrow();
    });

    it('不是 JSON 也是配置写错了，当场抛', () => {
      expect(() => resolveModelCapability(MODEL, ENDPOINT, '不是 JSON')).toThrow();
    });
  });
});
