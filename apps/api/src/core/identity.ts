import type { ActionType } from '@werewolf/shared';

declare const PHASE_INSTANCE_ID: unique symbol;

/**
 * 阶段实例身份：一局对弈中第 N 次执行的节点，形如 `node/1/vote`。
 *
 * 类型名 `PhaseInstanceId` 用「阶段实例」的叫法，格式里用 `node` 前缀；
 * 第三段是节点名，它可以不是 PHASES 里的阶段（spec 里就有 `init`、`night_resolve`）。
 * 三段以 `/` 分隔：
 *
 * - `node`  固定前缀，标明这是一个节点实例身份
 * - `1`     **执行序号**：本局第几次执行节点，从 0 起单调递增。
 *           不是天数，也不是节点编号——同名节点每天都会再执行一次
 * - `vote`  节点名：这一次停在流程的哪一站
 *
 * 「实例」二字是必要的：节点名会重复（每天都有 vote），「vote 节点」是一类，
 * 「第 3 次执行的 vote 节点」才是一个具体实例。
 *
 * 刻意不用裸 string：身份只能由 phaseInstanceId() 构造或 parsePhaseInstanceId()
 * 校验得到，任意字符串传不进来。身份的唯一性是行动键唯一性的前提，
 * 把它交给类型系统而不是调用方的自觉。
 */
export type PhaseInstanceId = string & { readonly [PHASE_INSTANCE_ID]: true };

/**
 * 序号不接受前导零：`node/01/vote` 与 `node/1/vote` 会成为两个字符串
 * 指向同一个节点实例，唯一性就破了。
 *
 * 节点名规则只写这一份，两个正则都从它拼出来：分开写迟早会漂成
 * 「构造器造得出、解析器不认」的身份。
 */
const NODE_NAME_SOURCE = '[A-Za-z]\\w*';
const NODE_NAME_PATTERN = new RegExp(`^${NODE_NAME_SOURCE}$`);
const PHASE_INSTANCE_ID_PATTERN = new RegExp(`^node/(0|[1-9]\\d*)/(${NODE_NAME_SOURCE})$`);

/** 构造节点实例身份。序号是本局第几次执行节点，从 0 起单调递增。 */
export function phaseInstanceId(ordinal: number, nodeName: string): PhaseInstanceId {
  assertOrdinal(ordinal, '节点序号');
  if (!NODE_NAME_PATTERN.test(nodeName)) throw new Error(`节点名不合法：${nodeName}`);
  return `node/${ordinal}/${nodeName}` as PhaseInstanceId;
}

/**
 * 校验并转换外来字符串（检查点、数据库）为节点实例身份；形状不合法返回 null。
 *
 * 本进程构造的身份不必走这里，直接调 phaseInstanceId()。
 */
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
 *
 * 组成是 JSON 元组 `[对局, 节点实例, 事件类型, 行动者, 行动序号]`。
 * 不用分隔符拼接：拼接是否可行取决于「每个字段都不含分隔符」，
 * 而这个前提类型系统并不保证——对局标识与行动者都是自由字符串，
 * 一旦其中一个带上分隔符，两个不同的行动就可能拼出同一个键。
 * JSON 自带转义与定界，不依赖字段内容的假设。
 *
 * 唯一性来源：节点实例在一局内不可能重复（序号单调递增），
 * 节点实例之内再由事件类型、行动者、行动序号区分同一节点的多次行动。
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
