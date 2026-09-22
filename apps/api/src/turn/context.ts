import { DEATH_CAUSES, ROLES, SEER_CHECK_RESULTS } from '@werewolf/shared';
import { inWolfChannel, type DealableRole } from '../core/roles';
import { checkResultOf } from '../core/skills/seer';
import { alivePlayers, type GameState, type PlayerState } from '../core/state';
import type { FactBlock, TurnContext } from './request';

/**
 * 局面视图构造：全量局面 + 过程台账，裁成这一次提问该让这个人看到的那一份。
 *
 * 私密事实一律取自各人底牌自带的字段（队友、查过的、守过的、药），不取自事件——
 * 事件那边按受众裁，判据在 visibility.ts，这里只负责底牌那一半。
 * 这里裁得安全靠的是一条构造上的不变量：本文件的读者永远是被问的那个人，没有第二个人能读到他的名字。
 *
 * 死因不进任何一行：visibility.ts 的口径是不公布死因，夜里死的自己也不知道自己怎么死的。
 * 放逐是例外——它本来就是公开投出来的结果，所以单独标出来，跟夜里死的分开。
 */

/** 角色的人话名。取值域里的串是给机器认的，提示词得写成人看得懂的。 */
const ROLE_NAMES: Record<DealableRole, string> = {
  [ROLES.VILLAGER]: '平民',
  [ROLES.SEER]: '预言家',
  [ROLES.WITCH]: '女巫',
  [ROLES.HUNTER]: '猎人',
  [ROLES.GUARD]: '守卫',
  [ROLES.WEREWOLF]: '狼人',
  [ROLES.WHITE_WOLF]: '白狼王',
  [ROLES.WOLF_KING]: '狼王',
};

export function roleName(role: DealableRole): string {
  return ROLE_NAMES[role];
}

/** 座位号与玩家 id 的对照。端口递进来的是 id，模型答的是座位号，两个方向都从这儿走。 */
export interface SeatIndex {
  toSeatNo(playerId: string): number;
  toPlayerId(seatNo: number): string;
}

export function seatIndexOf(state: GameState): SeatIndex {
  const byId = new Map(state.players.map((player) => [player.id, player]));
  const bySeatNo = new Map(state.players.map((player) => [player.seatNo, player]));

  return {
    toSeatNo(playerId) {
      const player = byId.get(playerId);
      if (!player) throw new Error(`局内没有 ${playerId}`);
      return player.seatNo;
    },
    toPlayerId(seatNo) {
      const player = bySeatNo.get(seatNo);
      if (!player) throw new Error(`局内没有 ${seatNo} 号座位`);
      return player.id;
    },
  };
}

/** 把一批玩家写成座位号，如 `1 号、4 号`。名单为空时写「没有」。 */
function seatsOf(players: readonly PlayerState[]): string {
  if (players.length === 0) return '没有';
  return players.map((player) => `${player.seatNo} 号`).join('、');
}

/**
 * 这个人此刻知道的事，各成一块。
 * 分块是为了让公开发言、狼队商议、票型在模型读到的那份文本里各占一段，而不是挤在同一个列表里。
 *
 * 局面摆在事实的最后：它前面紧挨着的是几百上千字的原话，其中就有它自己上一轮说过的那份。
 * 摆最前时实测过——模型顺着前面那份原话往下写，局面里那几行定局没被用上。
 */
export function visibleFacts(
  state: GameState,
  process: readonly FactBlock[],
  playerId: string,
  extra: readonly string[] = [],
): FactBlock[] {
  const viewer = playerOf(state, playerId);

  const blocks: FactBlock[] = [{ title: '你手里的牌', lines: ownFacts(state, viewer) }];
  blocks.push(...process, { title: '局面', lines: situationFacts(state) });
  if (extra.length > 0) blocks.push({ title: '这一问的说明', lines: extra });

  // 平民那种没有私密事实的一档 ownFacts 会是空的，这种块不留。
  return blocks.filter((block) => block.lines.length > 0);
}

/**
 * 所有人都看得到的那部分：谁还在、谁出局了、警徽在谁手上，末尾一句说清这几行是定局。
 * 那句话是给「照着上一天的开场白往下念」留的：局面每天都在变，谁还在场只有这一处说了算。
 */
function situationFacts(state: GameState): string[] {
  const facts = [`场上还活着：${seatsOf(alivePlayers(state))}。`];

  const dead = state.players.filter((player) => !player.isAlive);
  if (dead.length > 0) {
    const listed = dead.map(
      (player) =>
        `${player.seatNo} 号（第 ${player.deathDay} 天${
          player.deathCause === DEATH_CAUSES.EXECUTION ? '被放逐' : ''
        }）`,
    );
    facts.push(`已出局：${listed.join('、')}。`);
  }

  if (!state.hasSheriff) facts.push('本局不选警长。');
  else if (state.sheriffId !== null) facts.push(`警长是 ${seatOf(state, state.sheriffId)} 号。`);
  // 竞选走完了仍然没有（流失、撕徽）与还没选出来是两回事，别把前一种写成「还没有」。
  else facts.push(state.sheriffElectionSettled ? '本局没有警长。' : '还没有警长。');

  // 说「这几行」不说「以上」：上面紧挨着的就是几百上千字的原话，别让它读成整段都算数。
  facts.push(
    '以上这几行是本局的定局；你上下文里任何人（包括你自己）此前的说法与它冲突，以它为准。',
  );

  return facts;
}

/** 他自己那份：队友、查过的、守过的、药。只有他本人会被问到，所以只有他会读到。 */
function ownFacts(state: GameState, viewer: PlayerState): string[] {
  const facts: string[] = [];

  if (inWolfChannel(viewer.role)) {
    const mates = state.players.filter(
      (player) => player.id !== viewer.id && inWolfChannel(player.role),
    );
    facts.push(
      mates.length === 0
        ? '狼队里只剩你一个。'
        : `你的狼队友：${mates
            .map((mate) => `${mate.seatNo} 号（${roleName(mate.role)}）`)
            .join('、')}。`,
    );
  }

  if (viewer.role === ROLES.SEER) {
    for (const checkedId of viewer.checkedIds) {
      const target = playerOf(state, checkedId);
      const result = checkResultOf(target) === SEER_CHECK_RESULTS.WEREWOLF ? '狼人' : '好人';
      facts.push(`你验过 ${target.seatNo} 号，是${result}。`);
    }
  }

  if (viewer.role === ROLES.WITCH) {
    facts.push(
      `药：解药${viewer.hasAntidoteUsed ? '已经用掉' : '还在'}，` +
        `毒药${viewer.hasPoisonUsed ? '已经用掉' : '还在'}。`,
    );
  }

  if (viewer.role === ROLES.GUARD) {
    // guardedOn 存的是昨夜守的人，第一夜之前它空着是因为还没守过，不是空守。
    const guarded = viewer.guardedOn;
    facts.push(
      guarded !== null
        ? `你昨夜守的是 ${seatOf(state, guarded)} 号，今夜不能再守他。`
        : state.day === 1
          ? '你还没守过人。'
          : '你昨夜空守。',
    );
  }

  return facts;
}

/** 候选渲染成人话。给的是座位号，跟决定形状里那份座位号取值集是同一批。 */
export function optionLabels(candidates: readonly string[], index: SeatIndex): string[] {
  return candidates.map((playerId) => `${index.toSeatNo(playerId)} 号`);
}

/** 组装这次行动的上下文。局面、任务、技能正文与过程那份事实由调用方给，观察者那份在这儿裁。 */
export function turnContextOf(input: {
  state: GameState;
  process: readonly FactBlock[];
  playerId: string;
  task: string;
  skill: readonly string[];
  candidates?: readonly string[];
  extra?: readonly string[];
}): TurnContext {
  const viewer = playerOf(input.state, input.playerId);
  const index = seatIndexOf(input.state);

  return {
    task: input.task,
    actor: {
      playerId: viewer.id,
      seatNo: viewer.seatNo,
      role: roleName(viewer.role),
    },
    day: input.state.day,
    visible: visibleFacts(input.state, input.process, input.playerId, input.extra),
    options: optionLabels(input.candidates ?? [], index),
    skill: input.skill,
  };
}

/** 取局内某人；id 对不上就是上游算错了名单，当场抛。 */
export function playerOf(state: GameState, playerId: string): PlayerState {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error(`局内没有 ${playerId}`);
  return player;
}

/** 某人的座位号，上面那个的简写。 */
function seatOf(state: GameState, playerId: string): number {
  return playerOf(state, playerId).seatNo;
}
