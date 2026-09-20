import { canonicalJson } from './canonical-json';

describe('稳定序列化', () => {
  it('键序不同的同一份内容算出同一串', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('嵌套对象的键也跟着排', () => {
    expect(canonicalJson({ outer: { y: 1, x: 2 } })).toBe('{"outer":{"x":2,"y":1}}');
  });

  it('数组顺序原样留着，它是有含义的', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });
});
