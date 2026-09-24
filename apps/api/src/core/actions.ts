import type { SpeechSide } from './speech-order';
import type { BlastWindow } from './day/self-destruct';

/** 发言轮次：campaign 警上，campaign_pk 警上平票 PK，day 白天常规，exile_pk 放逐平票 PK。 */
export type SpeechTurn = 'campaign' | 'campaign_pk' | 'day' | 'exile_pk';

/**
 * 狼队夜间商议的轮次。
 * 定死两轮，不判收没收敛：判收敛要么再多一次模型调用，要么把提议和定案搅在一起，
 * 都不如直接走满——商议只是让各狼听见别人的想法，刀口照样是各提各的取众数。
 */
export const WOLF_DISCUSSION_ROUNDS = [1, 2] as const;

export type WolfRound = (typeof WOLF_DISCUSSION_ROUNDS)[number];

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
 * 方法都返回 Promise，真实实现等一个网络回合、用例替身直接给预置答案，引擎不用写两套推进。
 * 只收这次能选什么，不收状态快照，玩家该看到什么由调用方组装上下文时决定。
 */
export interface ActionProvider {
  /** 是否上警。 */
  runForSheriff(playerId: string): Promise<boolean>;
  /** 是否退水；退水即退出本次竞选，既不能被选也不能投票。 */
  withdraw(playerId: string): Promise<boolean>;
  /**
   * 发言内容。order 是这一轮的发言顺序，从第一个说到最后一个，轮次相同的人拿到的是同一份。
   * 谁已经说完、后面还有谁，都在这一份里，不必再单独告诉他排第几个。
   */
  speak(round: SpeechTurn, playerId: string, order: readonly string[]): Promise<string>;
  /** 投票落点；返回 null 为弃票，该轮不允许弃票时由计票抛错。 */
  vote(round: BallotTurn, playerId: string, candidates: readonly string[]): Promise<string | null>;
  /** 警长指定从自己左边还是右边开始发言。 */
  chooseSpeechSide(sheriffId: string, day: number): Promise<SpeechSide>;
  /** 警长出局时决定警徽去向；candidates 是可移交给的存活玩家。 */
  decideBadge(sheriffId: string, candidates: readonly string[]): Promise<BadgeDecision>;

  /**
   * 狼队夜间商议：轮到你说话。order 是本次商议的发言顺序，round 从 1 起。
   * 你说的话只有狼队频道看得到，会进后面发言者的上下文。
   */
  wolfSpeech(wolfId: string, round: WolfRound, order: readonly string[]): Promise<string>;
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

  /** 猎人开枪；candidates 是全体存活玩家。返回 null 为不开枪。 */
  hunterShot(hunterId: string, candidates: readonly string[]): Promise<string | null>;
  /** 狼王出局带人；candidates 是全体存活玩家。返回 null 为不带人。 */
  wolfKingShot(wolfKingId: string, candidates: readonly string[]): Promise<string | null>;
  /**
   * 并发询问狼队，返回首个有效回答要自爆的玩家；全部不自爆时返回 null。
   * 已裁决的窗口在恢复时复用原结果，其他请求尽量取消并收尾。
   */
  chooseBlaster(wolfIds: readonly string[], window: BlastWindow): Promise<string | null>;
  /**
   * 白狼王自爆带人；candidates 是存活玩家去掉他自己，返回 null 为不带人。
   * 他已是最后一狼时不该被问到，那样的一问没有答案可言。
   */
  whiteWolfTake(whiteWolfId: string, candidates: readonly string[]): Promise<string | null>;
}
