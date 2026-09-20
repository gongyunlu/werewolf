import { parseJsonOutput } from './parse-json-output';

describe('解析模型给的 JSON', () => {
  it('干净的输出直接解析', () => {
    expect(parseJsonOutput('{"a":1}')).toEqual({ a: 1 });
  });

  it('能力声明说能包围栏才剥，没声明就照原样解析', () => {
    expect(parseJsonOutput('```json\n{"a":1}\n```', true)).toEqual({ a: 1 });
    expect(() => parseJsonOutput('```json\n{"a":1}\n```', false)).toThrow(SyntaxError);
  });

  it('只剥包住整个输出的那一层，正文里夹的围栏不碰', () => {
    expect(() => parseJsonOutput('结果如下：\n```json\n{"a":1}\n```', true)).toThrow(SyntaxError);
  });

  it('不补括号、不修字段、不抽片段', () => {
    expect(() => parseJsonOutput('{"a":1', true)).toThrow(SyntaxError);
    expect(() => parseJsonOutput("{'a':1}", true)).toThrow(SyntaxError);
  });
});
