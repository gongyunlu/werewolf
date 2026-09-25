import { ACTION_TYPES, DEATH_CAUSES, FACTIONS, ROLES } from '@werewolf/shared';
import type { BoardId } from '../boards/boards';
import { createGameSetup } from '../boards/setup';
import type { StageAnchor } from '../core/loop';
import type { ModelCapability } from '../llm/model-capability';
import type { ModelAccess, ModelPort } from '../llm/model-port';
import type { SeatAccess } from '../agents/seat-context';
import type { StoredAskedPrompt } from '../store/asked';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';
import { wireOf } from '../queue/game-event-hub';
import { stubSkills } from '../testing/fixtures';
import { answeringModel, type RecordingModel } from '../testing/model';
import { answeringPlayer, breakingPlayer, playerAnswer } from '../testing/player';
import { ActionsController } from '../actions/actions.controller';
import { LOCAL_TURN_PROMPTS } from './prompt';
import { runModelGame } from './run-model-game';

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-用例',
  capability: {
    reasoningOff: null,
  } satisfies ModelCapability,
};

/** 随机源一直取 0：洗牌走同一条确定的路径，对局因此可复现。 */
const RANDOM = () => 0;

/** 跑一局，把假玩家收到的那一串和结果一起交出来；resume 给了就从那一格接着跑。 */
async function playGame(
  stores?: GameStores,
  options: {
    model?: ModelPort;
    resume?: StageAnchor;
    boardId?: BoardId;
    accessFor?: SeatAccess;
    memoriesFor?: (seatNo: number) => readonly string[];
  } = {},
) {
  const setup = createGameSetup({
    gameId: 'g1',
    boardId: options.boardId ?? '12p_wolf_king',
    random: RANDOM,
  });
  const model = (options.model ?? answeringPlayer()) as RecordingModel;

  const result = await runModelGame({
    setup,
    playerIds: setup.seats.map((seat) => `p${seat.seatNo}`),
    runtime: {
      port: model,
      accessFor: options.accessFor ?? (() => ACCESS),
      memoriesFor: options.memoriesFor ?? (() => []),
      skills: stubSkills(),
    },
    promptSource: LOCAL_TURN_PROMPTS,
    minuteOf: () => 0,
    stores,
    resume: options.resume,
  });

  return { result, model };
}

/**
 * 存储照旧，只把「按行动键取记录」这一下记下来。
 * 走到哪一问就取哪一个键：取了几次就是重走了几问，整局重放的取用次数跟整跑一样多。
 */
function countingStores(): { stores: GameStores; lookups: string[] } {
  const stores = memoryStores();
  const lookups: string[] = [];
  const find = stores.actions.find.bind(stores.actions);
  stores.actions.find = async (key) => {
    lookups.push(key);
    return find(key);
  };

  return { stores, lookups };
}

/**
 * 这一问是不是 3 号在答。
 * 首问与重问的系统提示词里写着坐几号，质疑那一问写在题面开头那一行；
 * 只认开头那一行：事实里也带着「N 号（身份）」，认整份题面会把别人的问认成他的。
 */
function askedSeat3(call: { system: string; prompt: string }): boolean {
  return call.system.includes('坐 3 号') || /^\s*第 \d+ 天，3 号（/.test(call.prompt);
}

/**
 * 替身照旧，只把每一次调用用的那份接入身份记下来。
 * 快照上那个型号是收尾那一刻取的，跟真发出去那一问用的是不是同一份，得从这儿看。
 */
function recordingAccess(inner: ModelPort) {
  const used: { model: string; system: string; prompt: string }[] = [];

  return {
    used,
    port: {
      generate: (request, access, options) => {
        used.push({ model: access.model, system: request.system, prompt: request.prompt });
        return inner.generate(request, access, options);
      },
    } satisfies ModelPort,
  };
}

/** 存储照旧，只把落下来的提问攒起来。 */
function recordingStores(): { stores: GameStores; rows: StoredAskedPrompt[] } {
  const stores = memoryStores();
  const rows: StoredAskedPrompt[] = [];
  const append = stores.asked.append.bind(stores.asked);
  stores.asked.append = async (gameId, asked) => {
    rows.push(asked);
    await append(gameId, asked);
  };

  return { stores, rows };
}

describe('整局接入', () => {
  it('首夜中刀的 4 号仍收到报名与警下投票，模型上下文和回放均在竞选后才显示死讯', async () => {
    const stores = memoryStores();
    const roles = [
      ROLES.WHITE_WOLF,
      ROLES.VILLAGER,
      ROLES.GUARD,
      ROLES.SEER,
      ROLES.WEREWOLF,
      ROLES.VILLAGER,
    ] as const;
    const port = answeringModel((request) => {
      const shape = JSON.stringify(request.tool?.parameters);
      if (shape?.includes('"accept"')) return playerAnswer(request);
      if (request.prompt.includes('这次要你做的事：决定今晚守护谁。')) return 'null';
      if (request.prompt.includes('这次要你做的事：决定今晚狼队刀谁。')) {
        return /^- 4 号$/m.test(request.prompt) ? '4' : '2';
      }
      return playerAnswer(request);
    });
    const result = await runModelGame({
      setup: {
        gameId: 'g-first-night-election',
        boardId: '6p_white_wolf',
        hasSheriff: true,
        seats: roles.map((role, index) => ({ role, seatNo: index + 1 })),
      },
      playerIds: roles.map((_role, index) => `p${index + 1}`),
      runtime: { port, accessFor: () => ACCESS, memoriesFor: () => [], skills: stubSkills() },
      promptSource: LOCAL_TURN_PROMPTS,
      minuteOf: () => 22,
      stores,
    });
    expect(result.state.players.find((player) => player.id === 'p4')).toMatchObject({
      deathDay: 1,
      deathCause: DEATH_CAUSES.NIGHT_KILL,
    });
    const campaign = result.outcomes
      .map((outcome) => outcome.snapshot)
      .filter((snapshot) => snapshot.actionKey.includes('/dawn'));
    expect(
      campaign.filter((snapshot) => snapshot.actionType === ACTION_TYPES.SHERIFF_CANDIDACY),
    ).toHaveLength(6);
    expect(
      campaign.some(
        (snapshot) => snapshot.actionType === ACTION_TYPES.VOTE && snapshot.actorId === 'p4',
      ),
    ).toBe(true);
    for (const snapshot of campaign) {
      expect(JSON.stringify(snapshot.context.visible)).not.toMatch(/已出局|昨晚 .*倒牌/);
    }
    const events = await stores.events.list('g-first-night-election');
    const resultEvent = events.find((event) => event.eventKey.endsWith('/election-result'))!;
    const dawnEvent = events.find((event) => event.eventKey.endsWith('/dawn'))!;
    expect(resultEvent.seq).toBeLessThan(dawnEvent.seq);
    expect(dawnEvent.text).toBe('昨晚 4 号 倒牌。');
    const summaries = await new ActionsController(stores).summaries('g-first-night-election');
    expect(
      summaries.actions
        .filter((action) => action.actionKey.includes('/dawn'))
        .every((action) => action.phase === 'day'),
    ).toBe(true);
  });

  it('法官流程持久化回放，私密结果不公开，同批决策不互相泄露', async () => {
    const stores = memoryStores();
    const { result } = await playGame(stores, { boardId: '6p_white_wolf' });
    const events = [...(await stores.events.list('g1'))];
    const check = events.find((event) => event.eventKey.endsWith('/seer-result'))!;
    const seer = result.state.players.find((player) => player.role === 'seer')!;
    expect(check.audience).toEqual([seer.id]);
    expect(check.text).toMatch(/查验结果：\d+ 号 是(?:好人|狼人)。/);
    expect(wireOf(check).phase).toBe('night');
    const dawn = events.find((event) => event.eventKey.endsWith('/dawn'))!;
    expect(wireOf(dawn).phase).toBe('day');
    expect(dawn.audience).toHaveLength(6);
    expect(dawn.text).toMatch(/昨晚/);
    expect(events.find((event) => event.eventKey.endsWith('/daybreak'))?.text).toBe('天亮了。');
    expect(events.at(-1)?.text).toContain('阵营获胜');
    for (const { snapshot } of result.outcomes.filter(
      (outcome) => outcome.snapshot.context.day === 1,
    )) {
      const context = JSON.stringify(snapshot.context.visible);
      if (snapshot.actionType === ACTION_TYPES.SHERIFF_CANDIDACY)
        expect(context).not.toContain('上警名单');
      if (snapshot.actionType === ACTION_TYPES.SHERIFF_WITHDRAW)
        expect(context).not.toContain('退水名单');
      expect(context).toContain('请所有玩家闭眼');
      if (snapshot.actorId !== seer.id) expect(context).not.toContain('查验结果：');
    }
    await playGame(stores, { boardId: '6p_white_wolf' });
    expect(await stores.events.list('g1')).toEqual(events);
  });

  it('从第一夜一路跑到分出胜负', async () => {
    const { result } = await playGame();

    expect([FACTIONS.GOOD, FACTIONS.WEREWOLF]).toContain(result.winner);
    expect(result.state.day).toBeGreaterThan(1);
    expect(result.state.players.some((player) => !player.isAlive)).toBe(true);
  });

  it('换成 6 人板也照样从头跑到分出胜负', async () => {
    const { result } = await playGame(undefined, { boardId: '6p_white_wolf' });

    expect(result.state.players).toHaveLength(6);
    expect([FACTIONS.GOOD, FACTIONS.WEREWOLF]).toContain(result.winner);
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
      expect(outcome.snapshot.prompts.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(result.outcomes.map((outcome) => outcome.snapshot))).not.toContain(
      ACCESS.apiKey,
    );
  });

  it('谁在答就用谁那份接入：真问出去的那一问与快照都按座位取', async () => {
    const own: ModelAccess = { ...ACCESS, model: '自带型号' };
    const { port, used } = recordingAccess(answeringPlayer());
    const { result } = await playGame(undefined, {
      model: port,
      accessFor: (seatNo) => (seatNo === 3 ? own : ACCESS),
    });

    const ours = used.filter(askedSeat3);
    const others = used.filter((call) => !askedSeat3(call));
    expect(ours.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    // 真发出去那一问用的就是座位那一份，不只是收尾记的：两者对不上时快照上的型号是句空话。
    expect(ours.map((call) => call.model)).toEqual(ours.map(() => own.model));
    expect(others.map((call) => call.model)).toEqual(others.map(() => ACCESS.model));

    // 快照上的型号也跟着座位走：一局里各人用的型号可以不是一个。
    const snapshotsOf = (isP3: boolean) =>
      result.outcomes.filter((outcome) => (outcome.snapshot.actorId === 'p3') === isP3);
    expect(snapshotsOf(true).map((outcome) => outcome.snapshot.model)).toEqual(
      snapshotsOf(true).map(() => own.model),
    );
    expect(snapshotsOf(false).map((outcome) => outcome.snapshot.model)).toEqual(
      snapshotsOf(false).map(() => ACCESS.model),
    );
  });

  it('人设与策略按座位拼进系统提示词，别人那份里没有', async () => {
    const persona = '## 你的人设\n\n### 说话短\n一句话不超过十个字';
    const { result } = await playGame(undefined, {
      memoriesFor: (seatNo) => (seatNo === 3 ? [persona] : []),
    });

    const systemOf = (actorId: string) =>
      result.outcomes
        .filter((outcome) => outcome.snapshot.actorId === actorId)
        .map((outcome) => outcome.snapshot.prompts.map((prompt) => prompt.text).join('\n'));

    // 拼在系统提示词里跟着提问一起发出去，快照上记的就是真发出去的那一段。
    expect(systemOf('p3').length).toBeGreaterThan(0);
    expect(systemOf('p3').every((text) => text.includes(persona))).toBe(true);
    expect(systemOf('p5').some((text) => text.includes(persona))).toBe(false);
  });

  it('前面答过的过程一路带着走，后面的提问看得到', async () => {
    const { model } = await playGame();

    const last = model.calls.at(-1);
    expect(last?.prompt).toContain('上警名单：');
    expect(last?.prompt).toContain(' 号发言：');
  });

  it('拿同一份存储再跑一遍，每一问都按记录复用，一次模型都不问', async () => {
    const stores = memoryStores();
    const first = await playGame(stores);

    // 断了再起时台账与记录都是整份铺回来的，比提问那一刻长出好几条；
    // 复算要按每问存下的记号取回当时那份事实，不然这一跑看到的就是整份台账，跟当初那一问对不上。
    const second = await playGame(stores);

    expect(second.model.calls).toHaveLength(0);
    expect(second.result.winner).toBe(first.result.winner);
    expect(second.result.state.players.map((player) => player.isAlive)).toEqual(
      first.result.state.players.map((player) => player.isAlive),
    );
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

  it('每一次提问都落一份，折摘要那一问也在里面', async () => {
    const { stores, rows } = recordingStores();
    const { model } = await playGame(stores);

    // 一处不漏：问出去几次就落几行，包括绕开行动图的那几问。
    expect(rows).toHaveLength(model.calls.length);
    // 折摘要不在行动里，它的那几行没有行动键——按这个就能跟玩家那几问分开。
    const summaries = rows.filter((row) => row.actionKey === null);
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((row) => row.tool?.description.includes('压成每人一条'))).toBe(true);
  });

  it('断在某一问上，那一问的题面也留得下', async () => {
    const { stores, rows } = recordingStores();
    const model = breakingPlayer(100);

    await expect(playGame(stores, { model })).rejects.toThrow('这一跑断在这儿');

    // 落的是发出去那一刻，不是答完之后：断的这一问连答复都没吐出来，那一行照样在。
    const broken = model.calls.at(-1);
    const row = rows.find((asked) => asked.prompt === broken?.prompt);
    expect(row).toBeDefined();
    // 断的这次是首问，不是重问那一版（重问那版题面也留得下，见 provider.spec 那条）。
    expect(row?.prompt).not.toContain('上一次交的');
    // 那一行指着行动记录里那条没答完的——崩在哪儿，按行动键就跟那一问对上了。
    const key = row?.actionKey;
    if (!key) throw new Error('断的这一问没落下行动键');
    expect(await stores.actions.find(key)).toMatchObject({ status: 'running' });
  });

  it('断在局中：从最后一份锚点接着跑，答过的那些不再问模型', async () => {
    const clean = await playGame();
    const { stores, lookups } = countingStores();
    // 在后半局中断，避免把续跑测试绑在商议轮数对应的固定调用次数上。
    await expect(
      playGame(stores, { model: breakingPlayer(Math.floor(clean.model.calls.length * 0.75)) }),
    ).rejects.toThrow('这一跑断在这儿');

    const anchor = await stores.steps.last('g1');
    if (!anchor) throw new Error('断了却没落下锚点');

    lookups.length = 0;
    const resumed = await playGame(stores, { resume: anchor });
    const asked = resumed.model.calls.map((call) => call.prompt);

    // 接着跑问的正好是整跑最后那一段：前面答过的一问都没重问，题面也一问不差。
    expect(asked).toEqual(
      clean.model.calls.slice(clean.model.calls.length - asked.length).map((call) => call.prompt),
    );
    // 断在大半之后接着跑，问的只该剩最后一小段：省下的那些全是从记录里复用的。
    expect(asked.length).toBeLessThan(clean.model.calls.length / 2);
    // 前面那几格一概不重放：接着跑只按断点之后的键取记录，前面答过的那些键一次都没碰。
    // 少了这一条，整局从头重放也照样过——重放时每一问都按记录复用，问出来的话一模一样。
    expect(lookups.length).toBeLessThan(clean.model.calls.length / 2);
    expect(resumed.result.winner).toBe(clean.result.winner);
    expect(resumed.result.state.players.map((player) => player.isAlive)).toEqual(
      clean.result.state.players.map((player) => player.isAlive),
    );
  });
});
