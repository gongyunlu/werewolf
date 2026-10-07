import { analysisOf, unitInput, type ReviewUnit } from './contracts';

const unit: ReviewUnit = {
  key: 'a',
  step: 'review_decision',
  traceId: 't',
  spanId: 's',
  createdAt: '',
  task: {},
  sources: [{ id: 'g/action/a/decision', origin: { actionKey: 'a', path: 'decision' }, value: 2 }],
};

it('模型只接收业务字段，内部节点和执行标识留在引用映射中', () => {
  const actionKey = '["g","node/5/night","vote","p1",0]';
  const input = unitInput({
    ...unit,
    task: { actionKey, actionType: 'vote', actorId: 'p1' },
    sources: [{ ...unit.sources[0]!, origin: { actionKey, path: 'decision' } }],
  });
  expect(input.task).toEqual({ actionType: 'vote', actorId: 'p1' });
  expect(input.sources[0]!.origin).toEqual({ path: 'decision' });
  expect(JSON.stringify(input)).not.toContain('node/5/night');
});
it('不属于当前输入的编号直接丢弃，映射只回冻结证据里的来源', () => {
  expect(analysisOf(unit, '判断 [证据:E1]', 'score', 'trace').references).toEqual([
    { label: 'E1', sourceId: 'g/action/a/decision' },
  ]);
  expect(analysisOf(unit, '判断 [E1]', 'score', 'trace').references[0]!.sourceId).toBe(
    'g/action/a/decision',
  );
  expect(() => analysisOf(unit, '判断 [证据:O1]', 'score', 'trace')).toThrow('缺少');
  expect(() => analysisOf(unit, '没有引用', 'score', 'trace')).toThrow('缺少');
  // 外局来源和捏造编号都进不了映射，正确那条不受牵连。
  const only = [{ label: 'E1', sourceId: 'g/action/a/decision' }];
  expect(
    analysisOf(unit, '有依据 [E1]。\n\n混入外局 [证据:foreign-game/result]。', 'score', 'trace')
      .references,
  ).toEqual(only);
  expect(analysisOf(unit, '有依据 [E1]。\n\n捏造 [X99]。', 'score', 'trace').references).toEqual(
    only,
  );
  expect(() =>
    analysisOf({ ...unit, step: 'review_player' }, '沿用局部编号 [证据:E1]', 'score', 'trace'),
  ).toThrow('缺少');
});

it('自然语言总结可以不重复编号，引用校验不代替内容质量评价', () => {
  const text = '本次选择为 2 号 [E1]。\n\n总体看，材料只记录了选择，是否生效还要看结算。';
  expect(analysisOf(unit, text, 'score', 'trace')).toMatchObject({
    text,
    references: [{ label: 'E1', sourceId: 'g/action/a/decision' }],
  });
});

it('接受可定位的裸编号，定位不到的丢弃，既有显式引用映射保持稳定', () => {
  expect(analysisOf(unit, 'E1 显示最终选择为 2。', 'score', 'trace').references).toEqual([
    { label: 'E1', sourceId: 'g/action/a/decision' },
  ]);
  const twoSources = { ...unit, sources: [...unit.sources, { ...unit.sources[0]!, id: 'other' }] };
  expect(analysisOf(twoSources, 'E2 补充背景。判断 [E1]。', 'score', 'trace').references).toEqual([
    { label: 'E1', sourceId: 'g/action/a/decision' },
  ]);
  expect(analysisOf(twoSources, '依据 E1/E2。', 'score', 'trace').references).toHaveLength(2);
  expect(() => analysisOf(unit, 'E999 显示结果。', 'score', 'trace')).toThrow('缺少');
  expect(analysisOf(unit, '有依据 [E1]。但 E999 不存在。', 'score', 'trace').references).toEqual([
    { label: 'E1', sourceId: 'g/action/a/decision' },
  ]);
  // 正文里会用 D1/D2 指第几天，跨层编号不可能是本次引用。
  const prose = '12 在 D1 已倾向 8 为真预，并计划 D2 优先查警下投 6 者 [E1]。';
  expect(analysisOf(unit, prose, 'score', 'trace').references).toEqual([
    { label: 'E1', sourceId: 'g/action/a/decision' },
  ]);
  // 一个括号里塞多条证据是模型常见写法，斜杠拆开后逐条定位。
  expect(analysisOf(twoSources, '依据 [E1/E2]。', 'score', 'trace').references).toHaveLength(2);
});

it('玩家嵌套引用只认指定决定的原始证据，借用其他决定的编号不产生引用', () => {
  const player: ReviewUnit = {
    ...unit,
    step: 'review_player',
    sources: [
      { ...unit.sources[0]!, value: { evidence: [{ id: 'E1', value: '报名' }] } },
      {
        ...unit.sources[0]!,
        id: 'g/assessment/later',
        value: {
          evidence: [
            { id: 'E1', value: '退水' },
            { id: 'E2', value: '原警下票权' },
          ],
        },
      },
    ],
  };
  const text = '报名记录见 D1-E1，退水不改变原警下投票资格 [D2-E2]。';
  expect(analysisOf(player, text, 'score', 'trace')).toMatchObject({
    text,
    references: [{ label: 'D2-E2', sourceId: 'g/assessment/later' }],
  });
  for (const citation of ['D1-E2', 'D3-E1', 'D2-O1', 'E1']) {
    expect(() => analysisOf(player, `越界 [${citation}]。`, 'score', 'trace')).toThrow('缺少');
  }
  const later = [{ label: 'D2-E2', sourceId: 'g/assessment/later' }];
  expect(analysisOf(player, '正确 [D2-E2]，捏造 D1-E2。', 'score', 'trace').references).toEqual(
    later,
  );
  expect(
    analysisOf(player, '两条同属一次决定 [D2-E1/D2-E2]。', 'score', 'trace').references,
  ).toEqual([{ label: 'D2-E1', sourceId: 'g/assessment/later' }, ...later]);
  expect(() => analysisOf(unit, '混用层级 [D1-E1]。', 'score', 'trace')).toThrow('缺少');
});

it('同层编号范围展开为逐项来源，倒序、跨层或越界范围不产生引用', () => {
  const outcome: ReviewUnit = {
    ...unit,
    step: 'review_outcome',
    sources: Array.from({ length: 3 }, (_, index) => ({
      ...unit.sources[0]!,
      id: `g/outcome/${index + 1}`,
    })),
  };
  const references = outcome.sources.map((source, index) => ({
    label: `O${index + 1}`,
    sourceId: source.id,
  }));
  expect(analysisOf(outcome, '票型 [O1-O3]。', 'score', 'trace').references).toEqual(references);
  expect(analysisOf(outcome, '票型见 O1-O3。', 'score', 'trace').references).toEqual(references);
  for (const citation of ['O3-O1', 'O1-O4', 'O1-O999999999', 'O1-E3', 'O0-O2']) {
    expect(() => analysisOf(outcome, `票型 [${citation}]。`, 'score', 'trace')).toThrow('缺少');
  }
});
