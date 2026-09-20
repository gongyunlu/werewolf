import { ACTION_TYPES, FACTIONS } from '@werewolf/shared';
import { createGameSetup } from '../boards/setup';
import type { ModelCapability } from '../llm/model-capability';
import type { ModelAccess, ModelRequest } from '../llm/model-port';
import { answeringModel } from '../testing/model';
import { LOCAL_TURN_PROMPTS, TURN_PROMPT_NAMES } from './prompt';
import { runModelGame } from './run-model-game';

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-用例',
  capability: {
    allowCodeFence: false,
    reasoningOff: null,
  } satisfies ModelCapability,
};

/** 随机源一直取 0：洗牌与并列抽签都走同一条确定的路径，对局因此可复现。 */
const RANDOM = () => 0;

/** 从提示词里读回来的两句：他坐几号，这次能选哪些座位。 */
function briefOf(request: ModelRequest): { seatNo: number; seats: number[] } {
  const seatNo = request.system.match(/坐 (\d+) 号/)?.[1];
  if (seatNo === undefined) throw new Error(`提示词里没写他坐几号：${request.system}`);

  return {
    seatNo: Number(seatNo),
    seats: [...request.prompt.matchAll(/^- (\d+) 号$/gm)].map((match) => Number(match[1])),
  };
}

/**
 * 假模型的作答口径。它除了提示词什么也没有，于是只能按提示词里的线索认这一问在问什么。
 * 认不出的形状不兜底：宁可当场炸，也不要它默默交一个形状合法的废话，把整局跑成一场假胜利。
 */
function answerOf(request: ModelRequest): string {
  // 质疑是唯一会问 accept 的那一问，一律通过，整局走不到修订。
  // 它的提示词里没有「他坐几号」那段自述，得排在取身份之前。
  if (request.prompt.includes('"accept"')) return JSON.stringify({ accept: true, issues: '' });

  const { seatNo, seats } = briefOf(request);

  // 女巫与警徽那一问每支都带 kind；能不用药、能撕掉就选那一支，不必再挑座位。
  if (request.prompt.includes('"const": "none"')) return JSON.stringify({ kind: 'none' });
  if (request.prompt.includes('"const": "tear"')) return JSON.stringify({ kind: 'tear' });

  // 上警、退水、自爆是同一个形状，只有这次要做什么分得开。
  // 前三号上警、其余不上，退水与自爆都不做：留出警下的人才有票投，警徽那一串流程也才走得到。
  if (request.prompt.includes('"type": "boolean"')) {
    return JSON.stringify(request.prompt.includes('决定是否上警竞选警长。') && seatNo <= 3);
  }

  if (request.prompt.includes('"left"')) return JSON.stringify('left');
  if (request.prompt.includes('"type": "number"')) return JSON.stringify(seats[0] ?? null);

  // 没有形状的那一问就是发言。
  return `我坐 ${seatNo} 号，先听前面的。`;
}

/** 跑完一整局，把假模型收到的那一串和结果一起交出来。 */
async function playGame() {
  const setup = createGameSetup({ gameId: 'g1', boardId: '12p_wolf_king', random: RANDOM });
  const model = answeringModel(answerOf);

  const result = await runModelGame({
    setup,
    playerIds: setup.seats.map((seat) => `p${seat.seatNo}`),
    runtime: { port: model, access: ACCESS },
    promptSource: LOCAL_TURN_PROMPTS,
    random: RANDOM,
    minuteOf: () => 0,
  });

  return { result, model };
}

describe('整局接入', () => {
  it('从第一夜一路跑到分出胜负', async () => {
    const { result } = await playGame();

    expect([FACTIONS.GOOD, FACTIONS.WEREWOLF]).toContain(result.winner);
    expect(result.state.day).toBeGreaterThan(1);
    expect(result.state.players.some((player) => !player.isAlive)).toBe(true);
  });

  it('竞选、发言、投票与夜里那几问都真的问出去了', async () => {
    const { result } = await playGame();

    const asked = new Set(result.outcomes.map((outcome) => outcome.snapshot.actionType));
    expect([...asked]).toEqual(
      expect.arrayContaining([
        ACTION_TYPES.SHERIFF_CANDIDACY,
        ACTION_TYPES.SHERIFF_WITHDRAW,
        ACTION_TYPES.SHERIFF_DECIDE_ORDER,
        ACTION_TYPES.SHERIFF_TRANSFER,
        ACTION_TYPES.SPEECH,
        ACTION_TYPES.VOTE,
        ACTION_TYPES.WOLF_PROPOSAL,
        ACTION_TYPES.GUARD_PROTECT,
        ACTION_TYPES.SEER_CHECK,
        ACTION_TYPES.WITCH_DECISION,
        ACTION_TYPES.WOLF_EXPLODE,
      ]),
    );
  });

  it('每次行动都留得下一份快照，密钥不进快照', async () => {
    const { result } = await playGame();

    expect(result.outcomes.length).toBeGreaterThan(0);
    for (const outcome of result.outcomes) {
      expect(outcome.snapshot.inputHash).toMatch(/^[0-9a-f]{64}$/);
      expect(outcome.snapshot.prompts.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(result.outcomes.map((outcome) => outcome.snapshot))).not.toContain(
      ACCESS.apiKey,
    );
  });

  it('前面答过的过程一路带着走，后面的提问看得到', async () => {
    const { model } = await playGame();

    const last = model.calls.at(-1);
    expect(last?.prompt).toContain(' 号上警。');
    expect(last?.prompt).toContain(' 号发言：');
  });

  it('同一份牌、同一个随机源跑两遍，出来的结果一样', async () => {
    const first = await playGame();
    const second = await playGame();

    expect(second.result.winner).toBe(first.result.winner);
    expect(second.result.outcomes.length).toBe(first.result.outcomes.length);
    expect(second.result.state.players.map((player) => player.isAlive)).toEqual(
      first.result.state.players.map((player) => player.isAlive),
    );
  });

  it('整局冻住的是同一份提示词', async () => {
    const { result } = await playGame();

    for (const name of Object.values(TURN_PROMPT_NAMES)) {
      expect(result.prompts[name].source).toBe('local');
      expect(result.prompts[name].version).toBeNull();
    }
  });
});
