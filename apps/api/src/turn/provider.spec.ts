import { ACTION_TYPES, ROLES } from '@werewolf/shared';
import { actionKey } from '../core/identity';
import type { GameState } from '../core/state';
import type { ModelCapability } from '../llm/model-capability';
import type { ModelAccess, ModelRequest } from '../llm/model-port';
import { makeState, withRoles } from '../testing/fixtures';
import { scriptedModel, type RecordingModel } from '../testing/model';
import { freezeTurnPrompts, type FrozenPrompts } from './prompt';
import { modelActions } from './provider';

const ACCESS: ModelAccess = {
  baseUrl: 'https://model.example.test/v1',
  model: '用例模型',
  apiKey: 'sk-用例',
  capability: {
    allowCodeFence: false,
    reasoningOff: null,
  } satisfies ModelCapability,
};

const ACCEPT = JSON.stringify({ accept: true, issues: '' });

let frozen: Promise<FrozenPrompts> | undefined;

/** 平台连不上，整局走本地兜底。冻结一次就够，这些用例不关心平台。 */
function prompts(): Promise<FrozenPrompts> {
  frozen ??= freezeTurnPrompts({ load: () => Promise.reject(new Error('平台连不上')) });
  return frozen;
}

/** 走 quality 档的答案表：每答一版后面都要接一次质疑，质疑一律通过。 */
function quality(...generated: readonly string[]): string[] {
  return generated.flatMap((answer) => [answer, ACCEPT]);
}

/** 造一副接了脚本模型的行动提供者，并把当前局面交给它。 */
async function withActions(state: GameState, answers: readonly (string | Error)[]) {
  const model = scriptedModel(answers);
  const actions = modelActions({ port: model, access: ACCESS, prompts: await prompts() });
  actions.observe(state);
  return { model, actions };
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

/** 六人局：id 是 p 加座位号，数字部分反过来读一眼就对上。 */
function sixPlayerState() {
  return withRoles(makeState(6), { p1: ROLES.WEREWOLF, p2: ROLES.WITCH, p4: ROLES.SEER });
}

describe('模型行动提供者', () => {
  describe('两态类', () => {
    it('上警问的是做不做，答案是布尔', async () => {
      const { model, actions } = await withActions(sixPlayerState(), ['true']);

      expect(await actions.runForSheriff('p3')).toBe(true);
      expect(decided(model)[0].prompt).toContain('决定是否上警竞选警长。');
      expect(decided(model)[0].prompt).toContain('"type": "boolean"');
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

      await actions.wolfBlast('p1', false);
      await actions.wolfBlast('p1', true);

      expect(decided(model)[0].prompt).toContain('现在是自爆窗口。');
      expect(decided(model)[1].prompt).toContain('竞选续轮里可以自爆。');
    });
  });

  describe('发言', () => {
    it('发言没有 schema，模型交的那段话原样带回', async () => {
      const { model, actions } = await withActions(
        sixPlayerState(),
        quality('我先过，1 号跳得有点急。'),
      );

      expect(await actions.speak('day', 'p3')).toBe('我先过，1 号跳得有点急。');
      expect(decided(model)[0].prompt).not.toContain('JSON Schema');
    });

    it('各轮发言各自有说法', async () => {
      const { model, actions } = await withActions(
        sixPlayerState(),
        quality('过', '过', '过', '过'),
      );

      await actions.speak('campaign', 'p3');
      await actions.speak('campaign_pk', 'p3');
      await actions.speak('day', 'p3');
      await actions.speak('exile_pk', 'p3');

      const asked = decided(model);
      [
        '轮到你上警发言。',
        '警上平票，轮到你做一轮 PK 发言。',
        '轮到你发言。',
        '放逐平票，轮到你做一轮 PK 发言。',
      ].forEach((task, index) => expect(asked[index].prompt).toContain(task));
    });

    it('发言进台账，正文收成一行', async () => {
      const { model, actions } = await withActions(
        sixPlayerState(),
        quality('我先过。\n\n  明天再聊。', '过'),
      );

      await actions.speak('day', 'p3');
      await actions.speak('day', 'p4');

      expect(decided(model)[1].prompt).toContain('3 号发言：我先过。 明天再聊。');
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
      expect(decided(model)[0].prompt).not.toContain('"type": "null"');
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
      expect(decided(model)[0].prompt).toContain('"left"');
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
      expect(decided(model)[0].prompt).toContain('"const": "antidote"');
    });

    it('刀口是她自己时救的那一支不摆出来，也不用规则解释一遍', async () => {
      const { model, actions } = await withActions(sixPlayerState(), quality('{"kind":"none"}'));

      expect(await actions.witchDecision('p2', 'p2', ['p1', 'p4'])).toEqual({ kind: 'none' });
      expect(decided(model)[0].prompt).toContain('今晚的刀口是你自己，解药救不了自己。');
      expect(decided(model)[0].prompt).not.toContain('"const": "antidote"');
      expect(decided(model)[0].prompt).not.toContain('解药只能用在今晚的刀口上');
    });

    it('看不到刀口时不说刀口是谁，救的那一支也不摆', async () => {
      const { model, actions } = await withActions(sixPlayerState(), quality('{"kind":"none"}'));

      expect(await actions.witchDecision('p2', null, ['p1', 'p4'])).toEqual({ kind: 'none' });
      expect(decided(model)[0].prompt).toContain('你今晚看不到刀口。');
      expect(decided(model)[0].prompt).not.toContain('"const": "antidote"');
    });

    it('毒药没得毒时不摆毒那一支，只剩不用', async () => {
      const { model, actions } = await withActions(sixPlayerState(), quality('{"kind":"none"}'));

      expect(await actions.witchDecision('p2', null, [])).toEqual({ kind: 'none' });
      expect(decided(model)[0].prompt).not.toContain('"const": "poison"');
    });
  });

  describe('台账', () => {
    it('上警、退水、警徽去向、发言方向各留下一条', async () => {
      const { model, actions } = await withActions(sixPlayerState(), [
        'true',
        'true',
        ...quality('{"kind":"tear"}'),
        '"left"',
        ...quality('过'),
      ]);

      await actions.runForSheriff('p3');
      await actions.withdraw('p4');
      await actions.decideBadge('p5', ['p1', 'p2']);
      await actions.chooseSpeechSide('p5', 1);
      await actions.speak('day', 'p6');

      expect(decided(model)[4].prompt).toMatch(
        /【第 1 天】[\s\S]*3 号上警。[\s\S]*4 号退水。[\s\S]*5 号撕掉了警徽。[\s\S]*警长 5 号决定从左边开始。/,
      );
    });

    it('投票与自爆不进台账，下一问里没有它们留下的痕迹', async () => {
      const { model, actions } = await withActions(sixPlayerState(), [
        ...quality('5'),
        'false',
        ...quality('过'),
      ]);

      await actions.vote('exile', 'p1', ['p4', 'p5']);
      await actions.wolfBlast('p1', false);
      await actions.speak('day', 'p3');

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
      await actions.speak('day', 'p3');

      // 退水那一问问了三次都没成，后面那条发言的提示词是第 4 条。
      expect(decided(model)[3].prompt).not.toContain('【第 1 天】');
    });
  });

  describe('序号、档位与局面', () => {
    it('同一节点实例里同一个人被问两次，靠序号分开', async () => {
      const { actions } = await withActions(sixPlayerState(), quality('过', '过'));

      await actions.speak('day', 'p3');
      await actions.speak('day', 'p3');

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

      await actions.speak('day', 'p3');
      await actions.runForSheriff('p3');
      await actions.speak('day', 'p4');

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
      await actions.speak('day', 'p3');

      expect(actions.outcomes().map((outcome) => outcome.snapshot.preset)).toEqual([
        'quick',
        'quality',
        'quality',
      ]);
    });

    it('行动键与序号发号器算出来的那一份对得上', async () => {
      const state = sixPlayerState();
      const { actions } = await withActions(state, quality('过'));

      await actions.speak('day', 'p3');

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

      await actions.speak('day', 'p3');

      expect(decided(model)[0].prompt).toContain('第 3 天。');
    });

    it('还没收到局面就调用是误用，当场抛', async () => {
      const model = scriptedModel(quality('过'));
      const actions = modelActions({ port: model, access: ACCESS, prompts: await prompts() });

      await expect(actions.speak('day', 'p3')).rejects.toThrow('还没收到当前局面');
    });

    it('局内没有的人递进来也是误用，当场抛', async () => {
      const { actions } = await withActions(sixPlayerState(), quality('过'));

      await expect(actions.speak('day', 'p9')).rejects.toThrow('局内没有 p9');
    });
  });
});
