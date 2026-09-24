import { ACTION_TYPES, ROLES, type PreviewChunk } from '@werewolf/shared';
import type { Ballot } from '../core/vote';
import { actionKey } from '../core/identity';
import { patchPlayer, type GameState } from '../core/state';
import type { ModelCapability } from '../llm/model-capability';
import type { ModelAccess, ModelRequest } from '../llm/model-port';
import type { StoredAskedPrompt } from '../store/asked';
import { memoryStores } from '../store/memory';
import type { GameStores } from '../store/stores';
import { makeState, stubSkills, withRoles } from '../testing/fixtures';
import { scriptedModel, type RecordingModel } from '../testing/model';
import { LOCAL_TURN_PROMPTS } from './prompt';
import { modelActions } from './provider';
import type { TurnRuntime } from './request';

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-用例',
  capability: {
    reasoningOff: null,
  } satisfies ModelCapability,
};

const ACCEPT = JSON.stringify({ accept: true, issues: '' });

/** 走 quality 档的答案表：每答一版后面都要接一次质疑，质疑一律通过。 */
function quality(...generated: readonly string[]): string[] {
  return generated.flatMap((answer) => [answer, ACCEPT]);
}

/** 造一副接了脚本模型的行动提供者，并把当前局面交给它。preview 给了就收下推出的每一片。 */
async function withActions(
  state: GameState,
  answers: readonly (string | Error)[],
  preview?: TurnRuntime['preview'],
) {
  const model = scriptedModel(answers);
  const stores = memoryStores();
  const actions = modelActions(
    {
      port: model,
      accessFor: () => ACCESS,
      memoriesFor: () => [],
      promptSource: LOCAL_TURN_PROMPTS,
      skills: stubSkills(),
      ...(preview ? { preview } : {}),
    },
    stores,
  );
  actions.observe(state);
  return { model, actions, stores };
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

/**
 * 那几问「要他做决定」的提示词，按发生顺序。
 * 质疑与修订的提示词里带着草稿或审核意见，从这几段文字认出来；档位换来换去也不影响这里的下标。
 */
function decided(model: RecordingModel): readonly ModelRequest[] {
  return model.calls.filter(
    (call) => !call.prompt.includes('他交上来的结果：') && !call.prompt.includes('审核意见：'),
  );
}

/**
 * 那一问交给模型的形状，转成文本好断言。
 * 形状走工具定义给（提示词里不贴 schema 了），没给工具的那一问就是发言，空串。
 */
function shapeOf(call: ModelRequest): string {
  return call.tool ? JSON.stringify(call.tool.parameters, null, 2) : '';
}

/** 六人局：id 是 p 加座位号，数字部分反过来读一眼就对上。 */
function sixPlayerState() {
  return withRoles(makeState(6), { p1: ROLES.WEREWOLF, p2: ROLES.WITCH, p4: ROLES.SEER });
}

/** 三狼局，其中 p3 昨夜已经出局：狼队频道里只剩 p1、p2。 */
function packState() {
  return withRoles(patchPlayer(makeState(7), 'p3', { isAlive: false }), {
    p1: ROLES.WEREWOLF,
    p2: ROLES.WEREWOLF,
    p3: ROLES.WEREWOLF,
  });
}

describe('模型行动提供者', () => {
  describe('两态类', () => {
    it('上警问的是做不做，答案是布尔', async () => {
      const { model, actions } = await withActions(sixPlayerState(), ['true']);

      expect(await actions.runForSheriff('p3')).toBe(true);
      expect(decided(model)[0].prompt).toContain('决定是否上警竞选警长。');
      expect(shapeOf(decided(model)[0])).toContain('"type": "boolean"');
    });

    it('退水答不做就是不做；答的不是布尔当场抛', async () => {
      const { actions } = await withActions(sixPlayerState(), ['false']);

      expect(await actions.withdraw('p3')).toBe(false);

      // 重问两次都还是同一个答错，才轮到抛。
      const bad = await withActions(sixPlayerState(), ['"是"', '"是"', '"是"']);
      await expect(bad.actions.withdraw('p3')).rejects.toMatchObject({ code: 'invalid_output' });
    });

    it('自爆问的是同一个形状，续轮换个说法', async () => {
      const { model, actions } = await withActions(sixPlayerState(), ['false', 'false']);

      await actions.chooseBlaster(['p1'], 'campaign');
      await actions.chooseBlaster(['p1'], 'campaign_resume');

      // 题面问的是「爆不爆」，不是「现在是什么窗口」：跟别的两态行动一样，先问再让他自己定。
      expect(decided(model)[0].prompt).toContain(
        '决定是否自爆。自爆会出局并跳过当天剩余的发言和放逐；完成尚未处理的死讯和技能结算后入夜。',
      );
      expect(decided(model)[1].prompt).toContain(
        '决定是否自爆。自爆会出局并使警徽流失；完成尚未处理的死讯和技能结算后入夜。',
      );
    });
  });

  describe('技能正文', () => {
    it('板子、角色、场景三段按这个顺序接在系统提示词后面', async () => {
      const { model, actions } = await withActions(sixPlayerState(), quality('过'));

      // sixPlayerState 里 p1 是狼，白天发言这一问三段都挂得上。
      await actions.speak('day', 'p1', []);

      const { system } = decided(model)[0];
      expect(system.indexOf('正文：ruleset/test')).toBeLessThan(
        system.indexOf('正文：roles/werewolf'),
      );
      expect(system.indexOf('正文：roles/werewolf')).toBeLessThan(
        system.indexOf('正文：scenarios/day_speech'),
      );
    });

    it('换个人问，角色那一份跟着换', async () => {
      const { model, actions } = await withActions(sixPlayerState(), quality('过', '过'));

      await actions.speak('day', 'p1', []);
      await actions.speak('day', 'p2', []);

      expect(decided(model)[0].system).toContain('正文：roles/werewolf');
      expect(decided(model)[1].system).toContain('正文：roles/witch');
      expect(decided(model)[1].system).not.toContain('正文：roles/werewolf');
    });

    it('不挂场景的那几问只带板子和角色，不留一个空段', async () => {
      const { model, actions } = await withActions(sixPlayerState(), ['true']);

      // 上警只有两态，没有场景正文可带。
      await actions.runForSheriff('p3');

      const { system } = decided(model)[0];
      expect(system).toContain('正文：ruleset/test');
      expect(system).toContain('正文：roles/villager');
      expect(system).not.toContain('正文：scenarios/');
    });

    it('投票、定发言方向与夜间那几问各挂各的场景', async () => {
      const { model, actions } = await withActions(sixPlayerState(), [
        ...quality('5'),
        '"right"',
        ...quality('null'),
        ...quality('null'),
        ...quality('6'),
        ...quality('{"kind":"none"}'),
      ]);

      await actions.vote('exile', 'p1', ['p4', 'p5']);
      await actions.chooseSpeechSide('p3', 1);
      await actions.wolfProposal('p1', ['p1', 'p3']);
      await actions.guardProtect('p3', ['p3', 'p5']);
      await actions.seerCheck('p4', ['p5', 'p6']);
      await actions.witchDecision('p2', null, ['p1', 'p4']);

      const systems = decided(model).map((call) => call.system);
      expect(systems[0]).toContain('正文：scenarios/vote');
      expect(systems[1]).toContain('正文：scenarios/sheriff_decide_order');
      // 提刀、守护、查验、用药四处共用夜间那一份。
      for (const system of systems.slice(2)) {
        expect(system).toContain('正文：scenarios/night_action');
      }
    });
  });

  describe('发言', () => {
    it('发言没有 schema，模型交的那段话原样带回', async () => {
      const { model, actions } = await withActions(
        sixPlayerState(),
        quality('我先过，1 号跳得有点急。'),
      );

      expect(await actions.speak('day', 'p3', [])).toBe('我先过，1 号跳得有点急。');
      // 没有形状可约束，这一问连工具都不给，让它写一段话。
      expect(decided(model)[0].tool).toBeUndefined();
    });

    it('各轮发言各自有说法', async () => {
      const { model, actions } = await withActions(
        sixPlayerState(),
        quality('过', '过', '过', '过'),
      );

      await actions.speak('campaign', 'p3', []);
      await actions.speak('campaign_pk', 'p3', []);
      await actions.speak('day', 'p3', []);
      await actions.speak('exile_pk', 'p3', []);

      const asked = decided(model);
      [
        '轮到你上警发言。',
        '警上平票，轮到你做一轮 PK 发言。',
        '轮到你发言。',
        '放逐平票，轮到你做一轮 PK 发言。',
      ].forEach((task, index) => expect(asked[index].prompt).toContain(task));
    });

    it('发言顺序进题面，各轮各一份', async () => {
      const { model, actions } = await withActions(sixPlayerState(), quality('过', '过'));

      await actions.speak('day', 'p3', ['p3', 'p4']);
      await actions.speak('exile_pk', 'p5', ['p6', 'p5']);

      expect(decided(model)[0].prompt).toContain('本轮发言顺序：3 号、4 号。');
      expect(decided(model)[1].prompt).toContain('本轮发言顺序：6 号、5 号。');
    });

    it('发言进台账，正文收成一行', async () => {
      const { model, actions } = await withActions(
        sixPlayerState(),
        quality('我先过。\n\n  明天再聊。', '过'),
      );

      await actions.speak('day', 'p3', []);
      await actions.speak('day', 'p4', []);

      expect(decided(model)[1].prompt).toContain('3 号发言：我先过。 明天再聊。');
    });

    it('商议发言落在狼队频道上：后说的狼读得到，频道外的人读不到', async () => {
      const { model, actions } = await withActions(packState(), [
        '今晚刀 7 号？',
        '我跟你。',
        ...quality('我过。'),
      ]);

      await actions.wolfSpeech('p1', 1, ['p1', 'p2']);
      await actions.wolfSpeech('p2', 1, ['p1', 'p2']);
      await actions.speak('day', 'p4', []);

      // 同一夜狼与狼之间是明牌：后说的那只在上下文里看得到前面说了什么。
      expect(decided(model)[1].prompt).toContain('1 号商议发言：今晚刀 7 号？');
      expect(decided(model)[2].prompt).not.toContain('商议发言');

      // 商议发言不带白天那份场景正文：它开头写着「所有人都会听到」，在狼队频道上是句假话。
      expect(decided(model)[0].system).not.toContain('正文：scenarios/');
      expect(decided(model)[2].system).toContain('正文：scenarios/day_speech');
      expect(model.calls).toHaveLength(4);
      expect(actions.outcomes().map((outcome) => outcome.snapshot.preset)).toEqual([
        'quick',
        'quick',
        'quality',
      ]);
    });

    it('受众是当时还在狼队频道里的人：出局的狼不算，平民也不算', async () => {
      const { actions, stores } = await withActions(packState(), ['今晚刀 7 号？']);

      await actions.wolfSpeech('p1', 1, ['p1', 'p2']);

      const chat = (await stores.events.list('g1')).find((row) => row.text.includes('商议发言'));
      expect(chat?.audience).toEqual(['p1', 'p2']);
    });
  });

  describe('票型那条事实', () => {
    /** 记一轮票型，把落进台账的那一条取回来。 */
    async function recorded(ballot: Ballot): Promise<string> {
      const { actions, stores } = await withActions(sixPlayerState(), []);
      await actions.recordBallot(ballot);

      const row = (await stores.events.list('g1')).find((event) => event.text.includes('投票：'));
      if (!row) throw new Error('没记下这一轮票型');
      return row.text;
    }

    it('逐张列出来，再接一句谁票最多', async () => {
      expect(
        await recorded({
          round: 'exile',
          casts: [
            { voterId: 'p1', targetId: 'p3' },
            { voterId: 'p2', targetId: 'p3' },
            { voterId: 'p4', targetId: null },
          ],
          outcome: { kind: 'elected', winnerId: 'p3', voteCount: 3 },
        }),
      ).toBe('放逐投票：1 号投给 3 号、2 号投给 3 号、4 号弃票；3 号票最多。');
    });

    it('平票时每个座位号各自带上「号」', async () => {
      expect(
        await recorded({
          round: 'exile_pk',
          casts: [
            { voterId: 'p1', targetId: 'p3' },
            { voterId: 'p2', targetId: 'p5' },
          ],
          outcome: { kind: 'tie', tiedIds: ['p3', 'p5'] },
        }),
      ).toBe('放逐 PK 投票：1 号投给 3 号、2 号投给 5 号；3 号、5 号平票。');
    });

    it('全员弃票时也说得出来', async () => {
      expect(
        await recorded({
          round: 'exile',
          casts: [{ voterId: 'p1', targetId: null }],
          outcome: { kind: 'none' },
        }),
      ).toBe('放逐投票：1 号弃票；全员弃票。');
    });
  });

  describe('观战那一头的推流', () => {
    /** 一副收预览的行动提供者；chunks 就是这一轮推出去的全部。 */
    async function watching(state: GameState, answers: readonly (string | Error)[]) {
      const chunks: PreviewChunk[] = [];
      const built = await withActions(state, answers, (chunk) => chunks.push(chunk));
      return { ...built, chunks };
    }

    it('并发行动各自推送，行动键与座位不会混在一起', async () => {
      const wolves = withRoles(makeState(6), {
        p1: ROLES.WEREWOLF,
        p2: ROLES.WEREWOLF,
        p3: ROLES.WEREWOLF,
      });
      const { actions, chunks } = await watching(wolves, ['false', 'false', 'false']);

      const asked = await actions.chooseBlaster(['p1', 'p2', 'p3'], 'day');

      expect(asked).toBeNull();
      expect(new Set(chunks.map((chunk) => chunk.seatNo))).toEqual(new Set([1, 2, 3]));
      expect(new Set(chunks.map((chunk) => chunk.actionKey)).size).toBe(3);
      expect(
        chunks.filter((chunk) => chunk.channel === 'node' && chunk.status === 'completed'),
      ).toHaveLength(6);
    });

    it('一前一后分别问就各推各的：这一刻只有它一张卡片', async () => {
      const { actions, chunks } = await watching(sixPlayerState(), quality('4', '4'));

      await actions.vote('exile', 'p1', ['p4']);
      await actions.vote('exile', 'p2', ['p4']);

      // 走工具的那一问只有思考那一头，每问两趟（生成、质疑）各一片。
      expect(chunks.filter((one) => one.channel !== 'node').map((one) => one.seatNo)).toEqual([
        1, 1, 2, 2,
      ]);
    });
  });

  describe('选座位类', () => {
    it('投票的候选按座位号摆出来，答案再换回 id', async () => {
      const { model, actions } = await withActions(sixPlayerState(), quality('5'));

      expect(await actions.vote('exile', 'p1', ['p4', 'p5'])).toBe('p5');
      expect(decided(model)[0].prompt).toContain('可以选的目标只有下面这些');
      expect(decided(model)[0].prompt).toContain('- 4 号');
      expect(decided(model)[0].prompt).toContain('- 5 号');
      expect(decided(model)[0].prompt).toContain('投空就是弃票。');
    });

    it('投空就是弃票，返回 null', async () => {
      const { actions } = await withActions(sixPlayerState(), quality('null'));

      expect(await actions.vote('exile', 'p1', ['p4'])).toBeNull();
    });

    it('候选外的座位答了也不作数，交给行动图拦下', async () => {
      const { actions } = await withActions(sixPlayerState(), ['3', '3', '3']);

      await expect(actions.vote('exile', 'p1', ['p4', 'p5'])).rejects.toMatchObject({
        code: 'invalid_output',
      });
    });

    it('查验必须给一个人，没有不做这一档', async () => {
      const { model, actions } = await withActions(sixPlayerState(), quality('6'));

      expect(await actions.seerCheck('p4', ['p5', 'p6'])).toBe('p6');
      expect(shapeOf(decided(model)[0])).not.toContain('"type": "null"');
    });

    it('提刀、守护与带人那几问都能空着', async () => {
      const { actions } = await withActions(
        sixPlayerState(),
        quality('null', 'null', 'null', 'null', 'null'),
      );

      expect(await actions.wolfProposal('p1', ['p1', 'p3'])).toBeNull();
      expect(await actions.guardProtect('p3', ['p3', 'p5'])).toBeNull();
      expect(await actions.hunterShot('p3', ['p1', 'p3'])).toBeNull();
      expect(await actions.wolfKingShot('p3', ['p1', 'p3'])).toBeNull();
      expect(await actions.whiteWolfTake('p3', ['p1', 'p3'])).toBeNull();
    });
  });

  describe('警长那几问', () => {
    it('发言方向答左还是右', async () => {
      const { model, actions } = await withActions(sixPlayerState(), ['"right"']);

      expect(await actions.chooseSpeechSide('p3', 1)).toBe('right');
      expect(shapeOf(decided(model)[0])).toContain('"left"');
    });

    it('警徽可以交给候选里的某个人', async () => {
      const { actions } = await withActions(
        sixPlayerState(),
        quality('{"kind":"transfer","seatNo":5}'),
      );

      expect(await actions.decideBadge('p3', ['p4', 'p5'])).toEqual({
        kind: 'transfer',
        toId: 'p5',
      });
    });

    it('警徽也可以撕掉', async () => {
      const { actions } = await withActions(sixPlayerState(), quality('{"kind":"tear"}'));

      expect(await actions.decideBadge('p3', ['p4', 'p5'])).toEqual({ kind: 'tear' });
    });
  });

  describe('女巫那一问', () => {
    it('刀口是别人时救的那一支摆得出来，刀口也写在局面里', async () => {
      const { model, actions } = await withActions(
        sixPlayerState(),
        quality('{"kind":"poison","seatNo":5}'),
      );

      expect(await actions.witchDecision('p2', 'p4', ['p1', 'p4', 'p5'])).toEqual({
        kind: 'poison',
        targetId: 'p5',
      });
      expect(decided(model)[0].prompt).toContain('今晚的刀口是 4 号。');
      expect(shapeOf(decided(model)[0])).toContain('"const": "antidote"');
    });

    it('刀口是她自己时救的那一支不摆出来，也不用规则解释一遍', async () => {
      const { model, actions } = await withActions(sixPlayerState(), quality('{"kind":"none"}'));

      expect(await actions.witchDecision('p2', 'p2', ['p1', 'p4'])).toEqual({ kind: 'none' });
      expect(decided(model)[0].prompt).toContain('今晚的刀口是你自己，解药救不了自己。');
      expect(shapeOf(decided(model)[0])).not.toContain('"const": "antidote"');
      expect(decided(model)[0].prompt).not.toContain('解药只能用在今晚的刀口上');
    });

    it('看不到刀口时不说刀口是谁，救的那一支也不摆', async () => {
      const { model, actions } = await withActions(sixPlayerState(), quality('{"kind":"none"}'));

      expect(await actions.witchDecision('p2', null, ['p1', 'p4'])).toEqual({ kind: 'none' });
      expect(decided(model)[0].prompt).toContain('你今晚看不到刀口。');
      expect(shapeOf(decided(model)[0])).not.toContain('"const": "antidote"');
    });

    it('毒药没得毒时不摆毒那一支，只剩不用', async () => {
      const { model, actions } = await withActions(sixPlayerState(), quality('{"kind":"none"}'));

      expect(await actions.witchDecision('p2', null, [])).toEqual({ kind: 'none' });
      expect(shapeOf(decided(model)[0])).not.toContain('"const": "poison"');
    });
  });

  describe('台账', () => {
    it('报名和退水由 Core 统一公布，单人答复不会提前进入他人的上下文', async () => {
      const state = sixPlayerState();
      const { model, actions, stores } = await withActions(state, [
        'true',
        'true',
        ...quality('{"kind":"tear"}'),
        '"left"',
        ...quality('过'),
      ]);

      await actions.runForSheriff('p3');
      await actions.withdraw('p4');
      expect(await stores.events.list(state.gameId)).toEqual([]);
      await actions.recordFlow(state, {
        key: 'candidacy-result',
        kind: 'sheriff',
        text: '上警名单：3 号、4 号。',
      });
      await actions.recordFlow(state, {
        key: 'withdraw-result',
        kind: 'sheriff',
        text: '退水名单：4 号。',
      });
      await actions.decideBadge('p5', ['p1', 'p2']);
      await actions.chooseSpeechSide('p5', 1);
      await actions.speak('day', 'p6', []);

      expect(decided(model)[4].prompt).toMatch(
        /【第 1 天】[\s\S]*上警名单：3 号、4 号。[\s\S]*退水名单：4 号。[\s\S]*5 号撕掉了警徽。[\s\S]*警长 5 号决定从左边开始。/,
      );
    });

    it('投票与自爆不进台账，下一问里没有它们留下的痕迹', async () => {
      const { model, actions } = await withActions(sixPlayerState(), [
        ...quality('5'),
        'false',
        ...quality('过'),
      ]);

      await actions.vote('exile', 'p1', ['p4', 'p5']);
      await actions.chooseBlaster(['p1'], 'day');
      await actions.speak('day', 'p3', []);

      expect(decided(model)[2].prompt).not.toContain('【第 1 天】');
    });

    it('没答成的那次提问也不留下半条', async () => {
      const { model, actions } = await withActions(sixPlayerState(), [
        '"是"',
        '"是"',
        '"是"',
        ...quality('过'),
      ]);

      await expect(actions.withdraw('p3')).rejects.toMatchObject({ code: 'invalid_output' });
      await actions.speak('day', 'p3', []);

      // 退水那一问问了三次都没成，后面那条发言的提示词是第 4 条。
      expect(decided(model)[3].prompt).not.toContain('【第 1 天】');
    });
  });

  describe('提交记录', () => {
    it('恢复旧存档时不在末尾补播已走过的流程，追上进度后正常播报', async () => {
      const state = sixPlayerState();
      const { model, actions, stores } = await withActions(state, ['true', 'false']);
      await actions.runForSheriff('p1');
      await actions.runForSheriff('p2');
      const resumed = modelActions(
        {
          port: model,
          accessFor: () => ACCESS,
          memoriesFor: () => [],
          promptSource: LOCAL_TURN_PROMPTS,
          skills: stubSkills(),
        },
        stores,
        state.phaseInstanceId,
      );
      resumed.observe(state);
      await resumed.recordFlow(state, { key: 'candidacy-start', text: '开始上警报名' });
      expect(await resumed.runForSheriff('p1')).toBe(true);
      await resumed.recordFlow(state, { key: 'past', text: '不应补到末尾的过去提示' });
      expect(await stores.events.list(state.gameId)).toEqual([]);
      expect(await resumed.runForSheriff('p2')).toBe(false);
      await resumed.recordFlow(state, {
        key: 'candidacy-result',
        text: '上警名单：1 号。',
        kind: 'sheriff',
      });
      expect((await stores.events.list(state.gameId)).map((event) => event.text)).toEqual([
        '上警名单：1 号。',
      ]);
      expect(model.calls).toHaveLength(2);
    });

    it('同一个键上答完过的那一次原样复用，不再问模型', async () => {
      const state = sixPlayerState();
      const { model, actions, stores } = await withActions(state, quality('过', '别的'));
      expect(await actions.speak('day', 'p3', [])).toBe('过');
      const asked = decided(model).length;

      // 断了再起：重走到同一问上，答过的那一行原样取回。
      const resumed = modelActions(
        {
          port: model,
          accessFor: () => ACCESS,
          memoriesFor: () => [],
          promptSource: LOCAL_TURN_PROMPTS,
          skills: stubSkills(),
        },
        stores,
      );
      resumed.observe(state);

      expect(await resumed.speak('day', 'p3', [])).toBe('过');
      expect(decided(model)).toHaveLength(asked);
    });

    it('记录里那一问的局面变了，答过的那一次照样复用', async () => {
      const state = sixPlayerState();
      const { model, actions, stores } = await withActions(state, quality('过', '别的'));
      expect(await actions.speak('day', 'p3', [])).toBe('过');
      const asked = decided(model).length;

      // 复用认的是行动键：同一局里它唯一确定一次提问，取不回别人的答案。
      // 局面变了也照样认这一行——当初答出来的就是对局历史里的那一份，不该被重问覆盖。
      const resumed = modelActions(
        {
          port: model,
          accessFor: () => ACCESS,
          memoriesFor: () => [],
          promptSource: LOCAL_TURN_PROMPTS,
          skills: stubSkills(),
        },
        stores,
      );
      resumed.observe({ ...state, day: 3 });

      expect(await resumed.speak('day', 'p3', [])).toBe('过');
      expect(decided(model)).toHaveLength(asked);
    });

    it('答完的那一问落成 done，结果就是交出去的那一份', async () => {
      const { actions, stores } = await withActions(sixPlayerState(), quality('过'));
      await actions.speak('day', 'p3', []);

      const [outcome] = actions.outcomes();
      const row = await stores.actions.find(outcome.snapshot.actionKey);

      expect(row).toMatchObject({
        status: 'done',
        outcome,
      });
    });

    it('不留事实的那一问（投票）照样复用：前后两条事实都不往回渗', async () => {
      const state = sixPlayerState();
      const { model, actions, stores } = await withActions(state, [
        ...quality('过'),
        ...quality('5'),
        ...quality('过'),
      ]);
      // 投票之前先有一问留了事实，之后又有一问留了事实：那两问的台账都不是投票这一刻这份。
      await actions.speak('day', 'p4', []);
      expect(await actions.vote('exile', 'p1', ['p4', 'p5'])).toBe('p5');
      await actions.speak('day', 'p3', []);
      const asked = model.calls.length;

      const resumed = modelActions(
        {
          port: model,
          accessFor: () => ACCESS,
          memoriesFor: () => [],
          promptSource: LOCAL_TURN_PROMPTS,
          skills: stubSkills(),
        },
        stores,
      );
      resumed.observe(state);

      expect(await resumed.vote('exile', 'p1', ['p4', 'p5'])).toBe('p5');
      expect(model.calls).toHaveLength(asked);
    });

    it('答「不上警」的那一问没留事实，重走照样复用', async () => {
      const state = sixPlayerState();
      const { model, actions, stores } = await withActions(state, ['false', ...quality('过')]);
      expect(await actions.runForSheriff('p3')).toBe(false);
      await actions.speak('day', 'p3', []);
      const asked = model.calls.length;

      const resumed = modelActions(
        {
          port: model,
          accessFor: () => ACCESS,
          memoriesFor: () => [],
          promptSource: LOCAL_TURN_PROMPTS,
          skills: stubSkills(),
        },
        stores,
      );
      resumed.observe(state);

      expect(await resumed.runForSheriff('p3')).toBe(false);
      expect(model.calls).toHaveLength(asked);
    });

    it('答了一半的投票，重走时接着把它跑完', async () => {
      const state = sixPlayerState();
      const { model, actions, stores } = await withActions(state, [
        new Error('模型那边断了'),
        ...quality('过'),
        ...quality('5'),
      ]);
      await expect(actions.vote('exile', 'p1', ['p4', 'p5'])).rejects.toThrow('模型那边断了');
      await actions.speak('day', 'p3', []);

      const resumed = modelActions(
        {
          port: model,
          accessFor: () => ACCESS,
          memoriesFor: () => [],
          promptSource: LOCAL_TURN_PROMPTS,
          skills: stubSkills(),
        },
        stores,
      );
      resumed.observe(state);

      expect(await resumed.vote('exile', 'p1', ['p4', 'p5'])).toBe('p5');
    });

    it('上一次断在这一问上，记录里还没答完，重走时照样问模型', async () => {
      const state = sixPlayerState();
      const { model, actions, stores } = await withActions(state, [
        new Error('模型那边断了'),
        ...quality('过'),
      ]);
      await expect(actions.speak('day', 'p3', [])).rejects.toThrow('模型那边断了');

      const resumed = modelActions(
        {
          port: model,
          accessFor: () => ACCESS,
          memoriesFor: () => [],
          promptSource: LOCAL_TURN_PROMPTS,
          skills: stubSkills(),
        },
        stores,
      );
      resumed.observe(state);

      expect(await resumed.speak('day', 'p3', [])).toBe('过');
    });

    it('断在质疑那一跑，重走时接上断点：生成不再重问，只补质疑那一问', async () => {
      const state = sixPlayerState();
      const { model, actions, stores } = await withActions(state, [
        '我先过，1 号跳得有点急。',
        new Error('模型那边断了'),
        ACCEPT,
      ]);
      await expect(actions.speak('day', 'p3', [])).rejects.toThrow('模型那边断了');
      const asked = model.calls.length;

      const resumed = modelActions(
        {
          port: model,
          accessFor: () => ACCESS,
          memoriesFor: () => [],
          promptSource: LOCAL_TURN_PROMPTS,
          skills: stubSkills(),
        },
        stores,
      );
      resumed.observe(state);

      expect(await resumed.speak('day', 'p3', [])).toBe('我先过，1 号跳得有点急。');
      // 生成那一问的答案在断点里，接着跑只补了质疑那一问；不认断点的话这里会多问一次。
      expect(model.calls).toHaveLength(asked + 1);
    });
  });

  describe('提问记录', () => {
    it('这一问问了几遍就落几行，重问那一次带着上一次交的是什么', async () => {
      const state = sixPlayerState();
      const { stores, rows } = recordingStores();
      // 候选是 4、5 号，先答一个不在里面的 7 号，附上说明重问一次才交对，之后接质疑。
      const model = scriptedModel(['7', '5', ACCEPT]);
      const actions = modelActions(
        {
          port: model,
          accessFor: () => ACCESS,
          memoriesFor: () => [],
          promptSource: LOCAL_TURN_PROMPTS,
          skills: stubSkills(),
        },
        stores,
      );
      actions.observe(state);

      await actions.guardProtect('p3', ['p4', 'p5']);

      const key = actionKey(
        { gameId: state.gameId, phaseInstanceId: state.phaseInstanceId },
        ACTION_TYPES.GUARD_PROTECT,
        'p3',
        0,
      );
      // 生成、重问、质疑是三次提问，一行一条，都归这一次行动：按行动键取回来就是这一问的全部。
      expect(rows.map((row) => row.actionKey)).toEqual([key, key, key]);
      // 判据取「上一次交的」这半句：题面本身就有「选别的都不作数」，只认「不作数」认不出来。
      expect(rows[0]?.prompt).not.toContain('上一次交的');
      expect(rows[1]?.prompt.startsWith(rows[0]?.prompt ?? '')).toBe(true);
      expect(rows[1]?.prompt).toContain('上一次交的');
      // 快照里记的是没附言那一版提示词，重问真发出去的那一份只有这张表留得住。
      expect(rows[2]?.prompt).toContain('他交上来的结果：');
    });
  });

  describe('序号、档位与局面', () => {
    it('同一节点实例里同一个人被问两次，靠序号分开', async () => {
      const { actions } = await withActions(sixPlayerState(), quality('过', '过'));

      await actions.speak('day', 'p3', []);
      await actions.speak('day', 'p3', []);

      const [first, second] = actions.outcomes();
      expect(first.snapshot.actionOrdinal).toBe(0);
      expect(second.snapshot.actionOrdinal).toBe(1);
      expect(second.snapshot.actionKey).not.toBe(first.snapshot.actionKey);
    });

    it('换个人或者换个行动类型，序号各从零起', async () => {
      const { actions } = await withActions(sixPlayerState(), [
        ...quality('过'),
        'true',
        ...quality('过'),
      ]);

      await actions.speak('day', 'p3', []);
      await actions.runForSheriff('p3');
      await actions.speak('day', 'p4', []);

      expect(actions.outcomes().map((outcome) => outcome.snapshot.actionOrdinal)).toEqual([
        0, 0, 0,
      ]);
    });

    it('档位按行动类型定，两态走 quick，选人与发言走 quality', async () => {
      const { actions } = await withActions(sixPlayerState(), [
        'true',
        ...quality('5'),
        ...quality('过'),
      ]);

      await actions.runForSheriff('p3');
      await actions.vote('exile', 'p1', ['p4', 'p5']);
      await actions.speak('day', 'p3', []);

      expect(actions.outcomes().map((outcome) => outcome.snapshot.preset)).toEqual([
        'quick',
        'quality',
        'quality',
      ]);
    });

    it('行动键与序号发号器算出来的那一份对得上', async () => {
      const state = sixPlayerState();
      const { actions } = await withActions(state, quality('过'));

      await actions.speak('day', 'p3', []);

      const [outcome] = actions.outcomes();
      expect(outcome.snapshot.actionKey).toBe(
        actionKey(
          { gameId: state.gameId, phaseInstanceId: state.phaseInstanceId },
          ACTION_TYPES.SPEECH,
          'p3',
          0,
        ),
      );
    });

    it('Core 后来交的那份局面才是这次提问的依据', async () => {
      const state = sixPlayerState();
      const { model, actions } = await withActions(state, quality('过'));
      actions.observe({ ...state, day: 3 });

      await actions.speak('day', 'p3', []);

      expect(decided(model)[0].prompt).toContain('第 3 天。');
    });

    it('还没收到局面就调用是误用，当场抛', async () => {
      const model = scriptedModel(quality('过'));
      const actions = modelActions(
        {
          port: model,
          accessFor: () => ACCESS,
          memoriesFor: () => [],
          promptSource: LOCAL_TURN_PROMPTS,
          skills: stubSkills(),
        },
        memoryStores(),
      );

      await expect(actions.speak('day', 'p3', [])).rejects.toThrow('还没收到当前局面');
    });

    it('局内没有的人递进来也是误用，当场抛', async () => {
      const { actions } = await withActions(sixPlayerState(), quality('过'));

      await expect(actions.speak('day', 'p9', [])).rejects.toThrow('局内没有 p9');
    });
  });
});
