import type { Faction } from '@werewolf/shared';
import { ALL_BOARDS, handOf, type BoardId } from '../boards/boards';
import { createGameSetup, type GameSetup } from '../boards/setup';
import type { DealableRole } from '../core/roles';
import { fingerprint } from '../turn/prompt-comparison';

export type ReferenceGameMode = 'none' | 'vector' | 'hybrid';
export type ReferenceGameVariant = 'baseline' | 'candidate';

export interface ReferenceGameFixture {
  pairId: string;
  seed: number;
  repetition: number;
  testedSeatNo: number;
  setup: GameSetup;
  modes: Record<ReferenceGameVariant, ReferenceGameMode>;
  order: ReferenceGameVariant[];
}

/** 开局与座位相同的一对实验，只改变被测玩家的引用模式。 */
export function referenceGameFixtures(input: {
  experimentId: string;
  boardId: BoardId;
  seeds: readonly number[];
  seatNos?: readonly number[];
  repetitions?: number;
  baseline?: ReferenceGameMode;
  candidate?: ReferenceGameMode;
}): ReferenceGameFixture[] {
  const count = handOf(ALL_BOARDS[input.boardId]).length;
  const seatNos = input.seatNos ?? Array.from({ length: count }, (_, i) => i + 1);
  const repetitions = input.repetitions ?? 1;
  const modes = { baseline: input.baseline ?? 'vector', candidate: input.candidate ?? 'hybrid' };
  if (
    !input.seeds.length ||
    new Set(input.seeds).size !== input.seeds.length ||
    input.seeds.some((seed) => !Number.isSafeInteger(seed))
  )
    throw new Error('种子必须是互不重复的整数');
  if (
    !seatNos.length ||
    new Set(seatNos).size !== seatNos.length ||
    seatNos.some((seat) => !Number.isInteger(seat) || seat < 1 || seat > count)
  )
    throw new Error('被测座位必须在板子范围内且不重复');
  if (!Number.isSafeInteger(repetitions) || repetitions < 1)
    throw new Error('重复次数必须是正整数');
  if (modes.baseline === modes.candidate) throw new Error('对照的引用模式必须不同');

  const fixtures: ReferenceGameFixture[] = [];
  for (const seed of input.seeds) {
    const setup = createGameSetup({
      gameId: input.experimentId,
      boardId: input.boardId,
      random: seededRandom(seed),
    });
    for (const testedSeatNo of seatNos) {
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        const pairId = `${input.experimentId}-${fixtures.length + 1}`;
        fixtures.push({
          pairId,
          seed,
          repetition,
          testedSeatNo,
          setup: { ...structuredClone(setup), gameId: pairId },
          modes: { ...modes },
          order: fixtures.length % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'],
        });
      }
    }
  }
  return fixtures;
}

function seededRandom(seed: number): () => number {
  let state = Number.parseInt(fingerprint(seed).slice(0, 8), 16);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ReferenceGameTrial {
  fixture: ReferenceGameFixture;
  variant: ReferenceGameVariant;
  mode: ReferenceGameMode;
  setup: GameSetup;
}

export interface ReferenceGameOutcome {
  winner: Faction;
  testedFaction: Faction;
  actionCount: number;
}

export interface ReferenceGameResult extends ReferenceGameOutcome {
  gameId: string;
  pairId: string;
  boardId: BoardId;
  role: DealableRole;
  testedSeatNo: number;
  seed: number;
  repetition: number;
  variant: ReferenceGameVariant;
  mode: ReferenceGameMode;
  won: boolean;
  conditionsHash: string;
  durationMs: number;
}

export async function runReferenceGameExperiment(input: {
  fixtures: readonly ReferenceGameFixture[];
  conditionsHash: string;
  run: (trial: ReferenceGameTrial) => Promise<ReferenceGameOutcome>;
  onResult: (result: ReferenceGameResult) => Promise<void>;
}): Promise<ReferenceGameResult[]> {
  const results: ReferenceGameResult[] = [];
  const fixtures = structuredClone(input.fixtures);
  for (const fixture of fixtures) {
    const role = fixture.setup.seats.find((seat) => seat.seatNo === fixture.testedSeatNo)!.role;
    for (const variant of fixture.order) {
      const gameId = `${fixture.pairId}-${variant}`;
      const started = performance.now();
      const outcome = await input.run({
        fixture: structuredClone(fixture),
        variant,
        mode: fixture.modes[variant],
        setup: { ...structuredClone(fixture.setup), gameId },
      });
      const result: ReferenceGameResult = {
        ...outcome,
        gameId,
        pairId: fixture.pairId,
        boardId: fixture.setup.boardId,
        role,
        testedSeatNo: fixture.testedSeatNo,
        seed: fixture.seed,
        repetition: fixture.repetition,
        variant,
        mode: fixture.modes[variant],
        won: outcome.winner === outcome.testedFaction,
        conditionsHash: input.conditionsHash,
        durationMs: Math.round(performance.now() - started),
      };
      results.push(result);
      await input.onResult(structuredClone(result));
    }
  }
  return results;
}

/** Wilson 区间在全胜、全负和小样本时仍保留不确定性。 */
export function winRateEstimate(wins: number, games: number) {
  if (!Number.isInteger(games) || games < 1 || !Number.isInteger(wins) || wins < 0 || wins > games)
    throw new Error('胜局数和总局数不合法');
  const rate = wins / games;
  const z = 1.959963984540054;
  const denominator = 1 + (z * z) / games;
  const center = (rate + (z * z) / (2 * games)) / denominator;
  const margin =
    (z * Math.sqrt((rate * (1 - rate)) / games + (z * z) / (4 * games * games))) / denominator;
  return {
    games,
    wins,
    rate,
    confidence95: [Math.max(0, center - margin), Math.min(1, center + margin)],
  };
}

/** 按被测玩家的角色统计，不能把一桌玩家的阵营胜负重复计为多个样本。 */
export function referenceGameSummary(results: readonly ReferenceGameResult[]) {
  const groups = new Map<string, ReferenceGameResult[]>();
  for (const result of results) {
    const key = `${result.boardId}/${result.role}`;
    const group = groups.get(key) ?? [];
    group.push(result);
    groups.set(key, group);
  }
  return [...groups.values()].map((rows) => {
    const pairs = new Map<string, Partial<Record<ReferenceGameVariant, ReferenceGameResult>>>();
    for (const row of rows) {
      const pair = pairs.get(row.pairId) ?? {};
      if (pair[row.variant]) throw new Error('同一配对中出现重复对照结果');
      pair[row.variant] = row;
      pairs.set(row.pairId, pair);
    }
    let candidateOnlyWins = 0;
    let baselineOnlyWins = 0;
    for (const pair of pairs.values()) {
      if (!pair.baseline || !pair.candidate) throw new Error('对照尚未完整完成，不能汇总胜率');
      if (pair.baseline.conditionsHash !== pair.candidate.conditionsHash)
        throw new Error('配对的固定条件不同，不能比较');
      if (pair.candidate.won && !pair.baseline.won) candidateOnlyWins++;
      if (pair.baseline.won && !pair.candidate.won) baselineOnlyWins++;
    }
    const estimate = (variant: ReferenceGameVariant) => {
      const variantRows = rows.filter((row) => row.variant === variant);
      return {
        mode: variantRows[0]!.mode,
        ...winRateEstimate(variantRows.filter((row) => row.won).length, variantRows.length),
      };
    };
    return {
      boardId: rows[0]!.boardId,
      role: rows[0]!.role,
      baseline: estimate('baseline'),
      candidate: estimate('candidate'),
      pairs: pairs.size,
      candidateOnlyWins,
      baselineOnlyWins,
      pairedWinRateDifference: (candidateOnlyWins - baselineOnlyWins) / pairs.size,
    };
  });
}
