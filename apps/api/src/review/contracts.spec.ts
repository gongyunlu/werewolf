import { analysisOf, type ReviewUnit } from './contracts';

const unit: ReviewUnit = {
  key: 'a',
  step: 'review_decision',
  traceId: 't',
  spanId: 's',
  createdAt: '',
  task: {},
  sources: [{ id: 'g/action/a/decision', origin: { actionKey: 'a', path: 'decision' }, value: 2 }],
};
it('短引用必须属于当前输入，映射回完整业务来源', () => {
  expect(analysisOf(unit, '判断 [证据:E1]', 'score', 'trace').references).toEqual([
    { label: 'E1', sourceId: 'g/action/a/decision' },
  ]);
  expect(analysisOf(unit, '判断 [E1]', 'score', 'trace').references[0]!.sourceId).toBe(
    'g/action/a/decision',
  );
  expect(() => analysisOf(unit, '判断 [证据:O1]', 'score', 'trace')).toThrow('超出');
  expect(() => analysisOf(unit, '没有引用', 'score', 'trace')).toThrow('缺少');
  expect(() =>
    analysisOf(unit, '有依据 [E1]。\n\n混入外局 [证据:foreign-game/result]。', 'score', 'trace'),
  ).toThrow('超出');
  expect(() => analysisOf(unit, '有依据 [E1]。\n\n捏造 [X99]。', 'score', 'trace')).toThrow('超出');
  expect(() => analysisOf(unit, '有依据 [E1]。\n\n另一段没有依据。', 'score', 'trace')).toThrow(
    '缺少',
  );
  expect(() =>
    analysisOf({ ...unit, step: 'review_player' }, '沿用局部编号 [证据:E1]', 'score', 'trace'),
  ).toThrow('超出');
});
