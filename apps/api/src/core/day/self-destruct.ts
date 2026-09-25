import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import type { ActionProvider } from '../actions';
import { triggerDeathSkills } from '../deaths';
import { seatNames, type FlowObserver } from '../flow';
import { inWolfChannel } from '../roles';
import { decideWhiteWolfTake } from '../skills/white-wolf';
import { alivePlayers, type GameState } from '../state';
import { checkWin } from '../win';
import { announceDay, type NightDeath } from './announce';
import { settleBadgeAfterDeaths } from './badge';

/** 每个允许自爆的阶段只在开始前询问一次，不在逐人发言之间追加询问。 */
export type BlastWindow =
  'campaign' | 'campaign_resume' | 'campaign_pk' | 'campaign_resume_pk' | 'day' | 'exile_pk';

export interface BlastResult {
  state: GameState;
  /** 有人自爆为 true；为 true 时当天剩下的全跳过。 */
  blasted: boolean;
}

/**
 * 自爆窗口：并行问狼队频道里的存活成员要不要爆，每只狼都看不到同伴的答案。
 *
 * 首个有效回答要自爆的玩家生效，与座位无关；取消其余请求后仍等待执行和记账收尾。
 *
 * 警上自爆后，外层仍会公布尚未出局者的夜间死讯并结算死亡技能。
 * 白狼王自爆时额外带走一人；被带走的人当场结算自己的出局技能，猎人开枪、狼王带人都在这一问里，
 * 跟放逐那条路径共用一套队列，见 deaths.ts。他爆完狼队就全灭的话当场就分出胜负了，轮不到带人那一步。
 *
 * 警徽在这里收尾：爆掉的可能是警长，他当天就得把徽交出去，拖到第二天早晨，候选名单
 * 已经被夜里的刀口改过。窗口有三个入口，留给调用点做迟早会漏；已经分出胜负的不结，
 * 见下面三处 checkWin。
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
  nightDeaths: readonly NightDeath[] = [],
): Promise<BlastResult> {
  const pack = alivePlayers(state).filter((player) => inWolfChannel(player.role));

  await onFlow?.(state, {
    key: `${window}-blast-start`,
    text: '进入自爆窗口，狼人同时决定是否自爆。',
  });

  const blasterId = await actions.chooseBlaster(
    pack.map((wolf) => wolf.id),
    window,
  );
  const blaster = pack.find((wolf) => wolf.id === blasterId);
  if (!blaster) {
    await onFlow?.(state, { key: `${window}-blast-result`, text: '无人自爆，继续当前流程。' });
    return { state, blasted: false };
  }
  const blast = announceDay(state, [
    { playerId: blaster.id, cause: DEATH_CAUSES.SELF_DESTRUCT },
  ]).state;
  observe?.(blast);
  await onFlow?.(blast, {
    key: `${window}-blast-result`,
    text: `${blaster.seatNo} 号自爆出局，今天剩余的发言和投票结束。`,
  });
  // 自爆是个原子出局事件，先单独落地、当场判一次：爆的是最后一只狼就到此为止，
  // 白狼王不再有机会带人，警徽也不必结。胜负只由 checkWin 一处说，见 skills/white-wolf.ts。
  if (checkWin(blast) !== null) return { state: blast, blasted: true };

  // 自爆覆盖实际出局原因，但吃毒仍会封住白狼王的带人能力。
  const poisoned = nightDeaths.some(
    (death) => death.playerId === blaster.id && death.cause === DEATH_CAUSES.WITCH_POISON,
  );
  const taken =
    blaster.role === ROLES.WHITE_WOLF && !poisoned
      ? await decideWhiteWolfTake(blaster, blast, actions, nightDeaths)
      : null;
  const deaths: NightDeath[] =
    taken === null ? [] : [{ playerId: taken, cause: DEATH_CAUSES.WHITE_WOLF_TAKE }];

  const announced = deaths.length === 0 ? blast : announceDay(blast, deaths).state;
  if (taken)
    await onFlow?.(announced, {
      key: `${window}-blast-take`,
      text: `${blaster.seatNo} 号发动技能，带走了 ${seatNames(announced, [taken])}。`,
    });
  observe?.(announced);
  // 带走的那张也可能是最后一个神职或最后一张平民，分出来了也没必要再问警徽给谁。
  if (checkWin(announced) !== null) return { state: announced, blasted: true };

  // 被带走的人当场结算自己的出局技能。没带人时 deaths 是空的，这一问什么都不问。
  const woken = await triggerDeathSkills(announced, deaths, actions, observe, onFlow, nightDeaths);
  if (checkWin(woken) !== null) return { state: woken, blasted: true };

  const after = await settleBadgeAfterDeaths(woken, actions);

  return { state: after, blasted: true };
}
