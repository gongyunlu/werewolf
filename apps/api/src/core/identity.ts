import type { ActionType } from '@werewolf/shared';

declare const PHASE_INSTANCE_ID: unique symbol;

/**
 * 阶段实例身份：一局里第 N 次执行的节点，形如 `node/1/vote`。
 * `1` 是本局第几次执行节点（从 0 起，不是天数）；节点名会重复，每天都有 vote，
 * 不带序号就指不出是哪一次。
 * 造只能走 phaseInstanceId()，读只能走 parsePhaseInstanceId()，裸 string 传不进来。
 */
export type PhaseInstanceId = string & { readonly [PHASE_INSTANCE_ID]: true };

/**
 * 序号不收前导零：`node/01/vote` 和 `node/1/vote` 会变成两个字符串指同一个实例。
 * 节点名规则只此一份，两个正则都从它拼。
 */
const NODE_NAME_SOURCE = '[A-Za-z]\\w*';
const NODE_NAME_PATTERN = new RegExp(`^${NODE_NAME_SOURCE}$`);
const PHASE_INSTANCE_ID_PATTERN = new RegExp(`^node/(0|[1-9]\\d*)/(${NODE_NAME_SOURCE})$`);

/** 构造节点实例身份。 */
export function phaseInstanceId(ordinal: number, nodeName: string): PhaseInstanceId {
  assertOrdinal(ordinal, '节点序号');
  if (!NODE_NAME_PATTERN.test(nodeName)) throw new Error(`节点名不合法：${nodeName}`);
  return `node/${ordinal}/${nodeName}` as PhaseInstanceId;
}

/** 由当前实例推进到下一个：序号加一，换成新节点名。序号全局自增，不按天重置。 */
export function nextPhaseInstanceId(current: PhaseInstanceId, nodeName: string): PhaseInstanceId {
  return phaseInstanceId(ordinalOf(current) + 1, nodeName);
}

/** 取已有身份里的序号。身份只造自 phaseInstanceId()，格式必合。 */
function ordinalOf(id: PhaseInstanceId): number {
  return Number(id.slice('node/'.length, id.lastIndexOf('/')));
}

/** 校验外来字符串（检查点、数据库），不合法返回 null。自己造的直接调 phaseInstanceId()。 */
export function parsePhaseInstanceId(value: string): PhaseInstanceId | null {
  const matched = PHASE_INSTANCE_ID_PATTERN.exec(value);
  if (!matched) return null;
  // 正则放行任意位数，但超出安全整数范围的序号无法精确比较大小，不算身份。
  return Number.isSafeInteger(Number(matched[1])) ? (value as PhaseInstanceId) : null;
}

/** 一次行动发生在哪一局、哪个节点实例。 */
export interface ActionScope {
  gameId: string;
  phaseInstanceId: PhaseInstanceId;
}

/**
 * 行动键：一局之内唯一标识一次行动，形如 `["g1","node/3/vote","vote","p2",0]`。
 * 用 JSON 元组 `[对局, 节点实例, 事件类型, 行动者, 行动序号]`，不拼分隔符：对局标识和
 * 行动者都是自由字符串，带上分隔符就可能拼出同一个键，JSON 自带转义和定界。
 * 节点实例在一局内不重复，实例之内再由事件类型、行动者、行动序号区分。
 */
export function actionKey(
  scope: ActionScope,
  actionType: ActionType,
  actorId: string,
  actionOrdinal = 0,
): string {
  if (!scope.gameId) throw new Error('行动键缺少对局标识');
  if (!actorId) throw new Error('行动键缺少行动者');
  assertOrdinal(actionOrdinal, '行动序号');
  return JSON.stringify([scope.gameId, scope.phaseInstanceId, actionType, actorId, actionOrdinal]);
}

function assertOrdinal(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label}必须是非负整数：${value}`);
}
