import type { SpeechSide } from './speech-order';

/**
 * 发言轮次。
 *
 * campaign：警上发言
 * campaign_pk：警上平票 PK 发言
 * day：白天常规发言
 * exile_pk：放逐平票 PK 发言
 */
export type SpeechTurn = 'campaign' | 'campaign_pk' | 'day' | 'exile_pk';

/** 投票轮次
 * compaign：警下投票
 * compaign_pk：警下平票 PK 投票
 * exile：放逐投票
 * exile_pk：放逐平票 PK 投票
 */
export type BallotTurn = 'campaign' | 'campaign_pk' | 'exile' | 'exile_pk';

/**
 * 警长的警徽处理：移交警徽/撕毁警徽。
 */
export type BadgeDecision = { kind: 'transfer'; toId: string } | { kind: 'tear' };

/**
 * 行动提供者：引擎向玩家要一个决定的入口。
 *
 * 每个方法都返回 Promise 而非同步值：真实实现要等一个网络回合，脚本实现在同一
 * 签名下返回预置答案，引擎不必为两者写两套推进逻辑。
 *
 * 方法只收「我能选什么」，不收状态快照——玩家该看到什么由调用方在组装上下文时
 * 决定，端口本身不承担可见性判断。
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
}

/**
 * 取一条脚本答案，没配到就抛错。
 *
 * 这里不给默认值：默认值会把「脚本漏配了这类行动」伪装成一次合法决策，
 * 跑出来的对局看着正常，实际走的不是脚本写的那条线。
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
  };
}
