import { z } from 'zod';
import { InvalidOutputError } from './model-port';
import { parseStructured, toolOf } from './structured-output';

describe('结构化答案解析', () => {
  it.each([3, true, '答案', null, { seatNo: 3 }])('接收按 Schema 包装的值 %j', (value) => {
    const schema = z.union([
      z.number(),
      z.boolean(),
      z.string(),
      z.null(),
      z.object({ seatNo: z.number() }),
    ]);
    expect(parseStructured(JSON.stringify({ value }), schema, '结果')).toEqual(value);
  });

  it.each(['null', '3', 'true', '"答案"', '[]', '{}'])('拒绝未包装的顶层内容 %s', (content) => {
    expect(() => parseStructured(content, z.unknown(), '结果')).toThrow(InvalidOutputError);
    expect(() => parseStructured(content, z.unknown(), '结果')).toThrow('结果不是裹着壳的对象');
  });

  it('保持顶层额外字段和内层 Schema 的既有接受范围', () => {
    expect(
      parseStructured(
        '{"value":{"seatNo":3,"extra":"内层字段"},"extra":"外层字段"}',
        z.object({ seatNo: z.number() }),
        '结果',
      ),
    ).toEqual({ seatNo: 3 });
  });
});

describe('工具定义', () => {
  it('形状裹进壳里发出去，顶层那份 $schema 剥掉', () => {
    const tool = toolOf(z.object({ seatNo: z.number() }), '交这次的答案');

    expect(tool.name).toBe('submit');
    expect(tool.description).toBe('交这次的答案');
    // 壳是必须的：工具参数只收 object 的 JSON Schema，形状本身不一定是。
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['value'],
      additionalProperties: false,
    });
    // $schema 是 JSON Schema 给自己写的版本声明，与这次要交的东西无关；留着它模型会连它一起抄回来交差。
    expect(tool.parameters).not.toHaveProperty('$schema');
    expect(tool.parameters).toMatchObject({ properties: { value: { type: 'object' } } });
  });
});
