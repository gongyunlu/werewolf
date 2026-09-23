import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import type { ActionProvider } from '../actions';
import { seatNames, type FlowObserver } from '../flow';
import { inWolfChannel } from '../roles';
import { settleActions } from '../parallel';
import { decideWhiteWolfTake } from '../skills/white-wolf';
import { alivePlayers, type GameState } from '../state';
import { checkWin } from '../win';
import { announceDay, type NightDeath } from './announce';
import { settleBadgeAfterDeaths } from './badge';

/** 自爆窗口：campaign 首轮警上，campaign_resume 竞选续轮，day 白天常规发言之前一次。 */
export type BlastWindow = 'campaign' | 'campaign_resume' | 'day';

export interface BlastResult {
  state: GameState;
  /** 有人自爆为 true；为 true 时当天剩下的全跳过。 */
  blasted: boolean;
}

/**
 * 自爆窗口：并行问狼队频道里的存活成员要不要爆，每只狼都看不到同伴的答案。
 *
 * 多只都想爆时由座位序定谁爆——规则里没有「两只一起爆」，第一只喊出来白天就结束了，
 * 谁先返回只看延迟，不能拿它定结果。收齐一轮，任一失败即整轮失败。
 *
 * 自爆只中断「发言 → 投票 → 放逐」，公布死讯和死亡技能都已经走完，不该被它截掉。
 * 白狼王自爆时额外带走一人；他爆完狼队就全灭的话当场就分出胜负了，轮不到带人那一步。
 * 被带走的人不会接着触发技能：狼王和猎人的死因表里都没有 white_wolf_take，见 skills/ 两个文件。
 *
 * 警徽在这里收尾：爆掉的可能是警长，他当天就得把徽交出去，拖到第二天早晨，候选名单
 * 已经被夜里的刀口改过。窗口有三个入口，留给调用点做迟早会漏；已经分出胜负的不结，
 * 见下面两处 checkWin。
 *
 * @param observe 交出现当局面的口子，见 GameLoopInput.observe。死讯落地到警徽那一问之间
 *   要交一次：接徽的人得先看见谁跟着爆掉了，不然候选名单里有刚死的人
 */
export async function runBlastWindow(
  state: GameState,
  window: BlastWindow,
  actions: ActionProvider,
  observe?: (state: GameState) => void,
  onFlow?: FlowObserver,
): Promise<BlastResult> {
  const pack = alivePlayers(state).filter((player) => inWolfChannel(player.role));

  await onFlow?.(state, {
    key: `${window}-blast-start`,
    text: '进入自爆窗口，狼人同时决定是否自爆。',
  });

  const answers = await settleActions(
    pack.map((wolf) => actions.wolfBlast(wolf.id, window === 'campaign_resume')),
  );
  const blaster = pack.find((_, index) => answers[index]);
  if (!blaster) {
    await onFlow?.(state, { key: `${window}-blast-result`, text: '无人自爆，继续当前流程。' });
    return { state, blasted: false };
  }
  await onFlow?.(state, {
    key: `${window}-blast-result`,
    text: `${blaster.seatNo} 号自爆出局，今天剩余的发言和投票结束。`,
  });

  const blast = announceDay(state, [
    { playerId: blaster.id, cause: DEATH_CAUSES.SELF_DESTRUCT },
  ]).state;
  observe?.(blast);
  // 自爆是个原子出局事件，先单独落地、当场判一次：爆的是最后一只狼就到此为止，
  // 白狼王不再有机会带人，警徽也不必结。胜负只由 checkWin 一处说，见 skills/white-wolf.ts。
  if (checkWin(blast) !== null) return { state: blast, blasted: true };

  const taken =
    blaster.role === ROLES.WHITE_WOLF ? await decideWhiteWolfTake(blaster, blast, actions) : null;
  const deaths: NightDeath[] =
    taken === null ? [] : [{ playerId: taken, cause: DEATH_CAUSES.WHITE_WOLF_TAKE }];

  const announced = deaths.length === 0 ? blast : announceDay(blast, deaths).state;
  if (taken)
    await onFlow?.(announced, {
      key: `${window}-blast-take`,
      text: `白狼王带走了 ${seatNames(announced, [taken])}。`,
    });
  observe?.(announced);
  // 带走的那张也可能是最后一个神职或最后一张平民，分出来了也没必要再问警徽给谁。
  if (checkWin(announced) !== null) return { state: announced, blasted: true };

  const after = await settleBadgeAfterDeaths(announced, actions);

  return { state: after, blasted: true };
}
