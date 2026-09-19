import { DEATH_CAUSES, ROLES } from '@werewolf/shared';
import type { ActionProvider } from '../actions';
import { inWolfChannel } from '../roles';
import { decideWhiteWolfTake } from '../skills/white-wolf';
import { alivePlayers, type GameState } from '../state';
import { announceDay, type NightDeath } from './announce';
import { settleBadgeAfterDeaths } from './badge';

/** 自爆窗口：campaign 首轮警上，campaign_resume 竞选续轮，day 白天发言前一次、之后每段发言各一次。 */
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
 * 白狼王自爆时额外带走一人；他已经是最后一狼就不带，问都不问。
 * 被带走的人不会接着触发技能：狼王和猎人的死因表里都没有 white_wolf_take，见 skills/ 两个文件。
 *
 * 警徽在这里收尾：爆掉的可能是警长，他当天就得把徽交出去，拖到第二天早晨，候选名单
 * 已经被夜里的刀口改过。窗口有三个入口，留给调用点做迟早会漏。
 */
export async function runBlastWindow(
  state: GameState,
  window: BlastWindow,
  actions: ActionProvider,
): Promise<BlastResult> {
  const pack = alivePlayers(state).filter((player) => inWolfChannel(player.role));

  const answers = await Promise.all(
    pack.map((wolf) => actions.wolfBlast(wolf.id, window === 'campaign_resume')),
  );
  const blaster = pack.find((_, index) => answers[index]);
  if (!blaster) return { state, blasted: false };

  const taken =
    blaster.role === ROLES.WHITE_WOLF ? await decideWhiteWolfTake(blaster, state, actions) : null;
  const deaths: NightDeath[] = [{ playerId: blaster.id, cause: DEATH_CAUSES.SELF_DESTRUCT }];
  if (taken !== null) deaths.push({ playerId: taken, cause: DEATH_CAUSES.WHITE_WOLF_TAKE });

  const after = await settleBadgeAfterDeaths(announceDay(state, deaths).state, actions);

  return { state: after, blasted: true };
}
