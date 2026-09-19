import type { SpeechSide } from './speech-order';

/** 发言轮次：campaign 警上，campaign_pk 警上平票 PK，day 白天常规，exile_pk 放逐平票 PK。 */
export type SpeechTurn = 'campaign' | 'campaign_pk' | 'day' | 'exile_pk';

/** 投票轮次：campaign 警下，campaign_pk 警下平票 PK，exile 放逐，exile_pk 放逐平票 PK。 */
export type BallotTurn = 'campaign' | 'campaign_pk' | 'exile' | 'exile_pk';

/** 警长的警徽处理：移交或撕毁。 */
export type BadgeDecision = { kind: 'transfer'; toId: string } | { kind: 'tear' };

/**
 * 女巫一次睁眼的决定：救、毒、或都不用。
 * 两药不能同夜并用，所以是三选一的联合类型而不是两个布尔，既救又毒写不出来。
 * 救只能是今晚的刀口，不携带目标，省得再写错一个 id。
 */
export type WitchDecision =
  { kind: 'antidote' } | { kind: 'poison'; targetId: string } | { kind: 'none' };

/**
 * 行动提供者：引擎向玩家要一个决定的入口。
 * 方法都返回 Promise，真实实现等一个网络回合、脚本实现直接给预置答案，引擎不用写两套推进。
 * 只收这次能选什么，不收状态快照，玩家该看到什么由调用方组装上下文时决定。
 */
export interface ActionProvider {
  /** 是否上警。 */
  runForSheriff(playerId: string): Promise<boolean>;
  /** 是否退水；退水即退出本次竞选，既不能被选也不能投票。 */
  withdraw(playerId: string): Promise<boolean>;
  /** 发言内容。 */
  speak(round: SpeechTurn, playerId: string): Promise<string>;
  /** 投票落点；返回 null 为弃票，该轮不允许弃票时由计票抛错。 */
  vote(round: BallotTurn, playerId: string, candidates: readonly string[]): Promise<string | null>;
  /** 警长指定从自己左边还是右边开始发言。 */
  chooseSpeechSide(sheriffId: string, day: number): Promise<SpeechSide>;
  /** 警长出局时决定警徽去向；candidates 是可移交给的存活玩家。 */
  decideBadge(sheriffId: string, candidates: readonly string[]): Promise<BadgeDecision>;

  /** 狼队提刀；candidates 是本夜可刀的存活玩家（含狼队友）。返回 null 为空刀。 */
  wolfProposal(wolfId: string, candidates: readonly string[]): Promise<string | null>;
  /**
   * 守卫守护；candidates 是存活玩家去掉他昨夜守过的那个人，返回 null 为空守。
   * 候选里没有刀口，他不知道今夜谁会挨刀，同守同救就是这么来的。
   */
  guardProtect(guardId: string, candidates: readonly string[]): Promise<string | null>;
  /** 预言家查验；candidates 是他还没查过的存活玩家，不含自己。 */
  seerCheck(seerId: string, candidates: readonly string[]): Promise<string>;
  /**
   * 女巫一次睁眼的决定。
   * killTargetId 是她今晚看得到的那个刀口，口径见 visibility.ts；为 null 只有一义，
   * 就是她看不到今晚的刀口（狼队空刀，或她已经用掉解药、用掉后不再获得新刀口）。
   * 刀口是她自己时也照样传进去，不能自救是解药的规则，不该在这里替她抹平；
   * 她若在被刀那夜选了救，调用方抛错。
   * poisonCandidates 是存活玩家去掉她自己。她看不到守卫守了谁，毒到被守护的人身上
   * 会真的毒死他，盾挡狼刀不挡毒。
   */
  witchDecision(
    witchId: string,
    killTargetId: string | null,
    poisonCandidates: readonly string[],
  ): Promise<WitchDecision>;
}

/** 脚本答案表：键是轮次、玩家 id 或天数，值与端口方法一一对应。 */
export interface ScriptedAnswers {
  /** 是否上警，按玩家 id。 */
  candidacy: Readonly<Record<string, boolean>>;
  /** 是否退水，按玩家 id。 */
  withdrawal: Readonly<Record<string, boolean>>;
  /** 发言内容，按轮次再按玩家 id。 */
  speech: Partial<Readonly<Record<SpeechTurn, Readonly<Record<string, string>>>>>;
  /** 投票落点，按轮次再按玩家 id；null 为弃票。 */
  ballot: Partial<Readonly<Record<BallotTurn, Readonly<Record<string, string | null>>>>>;
  /** 警长指定的发言起点侧，按天数。 */
  speechSide: Readonly<Record<string, SpeechSide>>;
  /** 警徽去向，按警长 id。 */
  badge: Readonly<Record<string, BadgeDecision>>;
  /** 狼队提刀，按狼人 id；null 为空刀。 */
  kill: Readonly<Record<string, string | null>>;
  /** 守卫守护，按守卫 id；null 为空守。 */
  guard: Readonly<Record<string, string | null>>;
  /** 预言家查验，按预言家 id。 */
  check: Readonly<Record<string, string>>;
  /** 女巫决定，按女巫 id。 */
  witch: Readonly<Record<string, WitchDecision>>;
}

/**
 * 取一条脚本答案，没配到就抛错。
 * 不给默认值：漏配会被伪装成一次合法决策，对局看着正常，实际走的不是脚本那条线。
 */
function pickAnswer<T>(
  source: Readonly<Record<string, T>> | undefined,
  key: string,
  what: string,
): T {
  const value = source?.[key];
  if (value === undefined) throw new Error(`脚本缺少回答：${what}`);
  return value;
}

/** 用一张答案表驱动的行动提供者。 */
export function scriptedActions(answers: ScriptedAnswers): ActionProvider {
  return {
    async runForSheriff(playerId) {
      return pickAnswer(answers.candidacy, playerId, `${playerId} 是否上警`);
    },
    async withdraw(playerId) {
      return pickAnswer(answers.withdrawal, playerId, `${playerId} 是否退水`);
    },
    async speak(round, playerId) {
      return pickAnswer(answers.speech[round], playerId, `${round} 轮 ${playerId} 的发言`);
    },
    async vote(round, playerId) {
      return pickAnswer(answers.ballot[round], playerId, `${round} 轮 ${playerId} 的投票`);
    },
    async chooseSpeechSide(sheriffId, day) {
      return pickAnswer(
        answers.speechSide,
        String(day),
        `第 ${day} 天 ${sheriffId} 指定的发言方向`,
      );
    },
    async decideBadge(sheriffId) {
      return pickAnswer(answers.badge, sheriffId, `${sheriffId} 的警徽去向`);
    },
    async wolfProposal(wolfId) {
      return pickAnswer(answers.kill, wolfId, `${wolfId} 的刀口`);
    },
    async guardProtect(guardId) {
      return pickAnswer(answers.guard, guardId, `${guardId} 的守护目标`);
    },
    async seerCheck(seerId) {
      return pickAnswer(answers.check, seerId, `${seerId} 的查验目标`);
    },
    async witchDecision(witchId) {
      return pickAnswer(answers.witch, witchId, `${witchId} 的用药决定`);
    },
  };
}
