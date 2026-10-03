import { FACTIONS } from '@werewolf/shared';
import { handOf, ALL_BOARDS } from '../boards/boards';
import { factionOf } from '../core/roles';
import {
  referenceGameFixtures,
  referenceGameSummary,
  runReferenceGameExperiment,
  winRateEstimate,
  type ReferenceGameOutcome,
  type ReferenceGameResult,
  type ReferenceGameTrial,
} from './game-experiment';

const design = {
  experimentId: '固定对照',
  boardId: '6p_white_wolf' as const,
  seeds: [13, 29],
};

function outcome(trial: ReferenceGameTrial, won: boolean): ReferenceGameOutcome {
  const role = trial.setup.seats.find((seat) => seat.seatNo === trial.fixture.testedSeatNo)!.role;
  const testedFaction = factionOf(role);
  return {
    winner: won
      ? testedFaction
      : testedFaction === FACTIONS.GOOD
        ? FACTIONS.WEREWOLF
        : FACTIONS.GOOD,
    testedFaction,
    actionCount: 30,
  };
}

it('固定种子复现发牌，完整座位轮换覆盖板子内每张角色牌，执行次序交替', () => {
  const fixtures = referenceGameFixtures(design);
  expect(fixtures).toEqual(referenceGameFixtures(design));
  expect(fixtures).toHaveLength(12);
  for (const seed of design.seeds) {
    const rows = fixtures.filter((fixture) => fixture.seed === seed);
    expect(new Set(rows.map((row) => JSON.stringify(row.setup.seats))).size).toBe(1);
    const roles = rows.map((row) => row.setup.seats[row.testedSeatNo - 1]!.role).toSorted();
    expect(roles).toEqual(handOf(ALL_BOARDS[design.boardId]).toSorted());
  }
  expect(fixtures[0]!.order).toEqual(['baseline', 'candidate']);
  expect(fixtures[1]!.order).toEqual(['candidate', 'baseline']);
  expect(fixtures[0]!.modes).toEqual({ baseline: 'vector', candidate: 'hybrid' });
});

it('重复次数复用相同开局，被测座位不依赖运行时随机数', () => {
  const fixtures = referenceGameFixtures({ ...design, seeds: [13], seatNos: [2], repetitions: 2 });
  expect(fixtures).toHaveLength(2);
  expect(fixtures.map((row) => row.repetition)).toEqual([1, 2]);
  expect(fixtures[0]!.setup.seats).toEqual(fixtures[1]!.setup.seats);
  expect(fixtures.map((row) => row.testedSeatNo)).toEqual([2, 2]);
});

it('配对只改变模式和日志局号，运行器修改副本不会污染另一组输入', async () => {
  const fixtures = referenceGameFixtures({ ...design, seeds: [13], seatNos: [1] });
  const original = structuredClone(fixtures);
  const trials: ReferenceGameTrial[] = [];
  const saved: ReferenceGameResult[] = [];
  const results = await runReferenceGameExperiment({
    fixtures,
    conditionsHash: '固定条件',
    async run(trial) {
      trials.push(structuredClone(trial));
      const result = outcome(trial, trial.variant === 'candidate');
      trial.fixture.order.reverse();
      return result;
    },
    async onResult(result) {
      saved.push(result);
    },
  });
  expect(fixtures).toEqual(original);
  expect(trials.map((trial) => trial.mode)).toEqual(['vector', 'hybrid']);
  expect(trials[0]!.setup.seats).toEqual(trials[1]!.setup.seats);
  expect(trials[0]!.setup.gameId).not.toBe(trials[1]!.setup.gameId);
  expect(results.map((result) => result.won)).toEqual([false, true]);
  expect(saved).toEqual(results);
  expect(results.every((result) => result.conditionsHash === '固定条件')).toBe(true);
});

it('一组失败立即停止，不把未完成配对记作负局或继续烧模型调用', async () => {
  const fixtures = referenceGameFixtures({ ...design, seeds: [13], seatNos: [1, 2] });
  const saved: ReferenceGameResult[] = [];
  const run = jest.fn(async (trial: ReferenceGameTrial) => {
    if (trial.variant === 'candidate') throw new Error('供应商故障');
    return outcome(trial, true);
  });
  await expect(
    runReferenceGameExperiment({
      fixtures,
      conditionsHash: '固定条件',
      run,
      async onResult(result) {
        saved.push(result);
      },
    }),
  ).rejects.toThrow('供应商故障');
  expect(run).toHaveBeenCalledTimes(2);
  expect(saved).toHaveLength(1);
  expect(() => referenceGameSummary(saved)).toThrow('对照尚未完整完成');
});

it('每局仅被测玩家贡献一个样本，按角色报告区间和配对胜负', async () => {
  const fixtures = referenceGameFixtures({ ...design, seeds: [13] });
  const results = await runReferenceGameExperiment({
    fixtures,
    conditionsHash: '固定条件',
    run: async (trial) => outcome(trial, trial.variant === 'candidate'),
    onResult: async () => {},
  });
  const summary = referenceGameSummary(results);
  expect(summary.reduce((sum, group) => sum + group.baseline.games, 0)).toBe(6);
  expect(summary.reduce((sum, group) => sum + group.candidate.games, 0)).toBe(6);
  const villagers = summary.find((group) => group.role === 'villager')!;
  expect(villagers).toMatchObject({
    pairs: 2,
    baseline: { games: 2, wins: 0, rate: 0 },
    candidate: { games: 2, wins: 2, rate: 1 },
    candidateOnlyWins: 2,
    baselineOnlyWins: 0,
    pairedWinRateDifference: 1,
  });
  expect(villagers.candidate.confidence95[0]).toBeLessThan(0.5);
  expect(villagers.baseline.confidence95[1]).toBeGreaterThan(0.5);
  expect(winRateEstimate(5, 10).confidence95[0]).toBeCloseTo(0.2366, 4);
  expect(winRateEstimate(5, 10).confidence95[1]).toBeCloseTo(0.7634, 4);
});

it('拒绝重复种子、越界座位、无效重复次数和相同模式', () => {
  expect(() => referenceGameFixtures({ ...design, seeds: [1, 1] })).toThrow('种子');
  expect(() => referenceGameFixtures({ ...design, seatNos: [7] })).toThrow('座位');
  expect(() => referenceGameFixtures({ ...design, repetitions: 0 })).toThrow('重复次数');
  expect(() => referenceGameFixtures({ ...design, baseline: 'none', candidate: 'none' })).toThrow(
    '模式',
  );
});
