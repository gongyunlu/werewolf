import { ACTION_TYPES, DEATH_CAUSES, FACTIONS, GAME_STATUSES, ROLES } from '@werewolf/shared';

/**
 * 展示用的中文名。取值域在 shared 里，名字只在这一处；认不出来的原样显示，
 * 后端加了牌或状态前端不至于白屏。
 */
const ROLE_NAMES: Record<string, string> = {
  [ROLES.VILLAGER]: '平民',
  [ROLES.SEER]: '预言家',
  [ROLES.WITCH]: '女巫',
  [ROLES.GUARD]: '守卫',
  [ROLES.HUNTER]: '猎人',
  [ROLES.WEREWOLF]: '狼人',
  [ROLES.WHITE_WOLF]: '白狼王',
  [ROLES.WOLF_KING]: '狼王',
};

const FACTION_NAMES: Record<string, string> = {
  [FACTIONS.GOOD]: '好人',
  [FACTIONS.WEREWOLF]: '狼人',
  [FACTIONS.THIRD_PARTY]: '第三方',
};

const STATUS_NAMES: Record<string, string> = {
  [GAME_STATUSES.QUEUED]: '排队中',
  [GAME_STATUSES.RUNNING]: '进行中',
  [GAME_STATUSES.FINISHED]: '已结束',
  [GAME_STATUSES.FAILED]: '中断',
};

const DEATH_CAUSE_NAMES: Record<string, string> = {
  [DEATH_CAUSES.NIGHT_KILL]: '夜里被杀',
  [DEATH_CAUSES.WITCH_POISON]: '女巫毒杀',
  [DEATH_CAUSES.DOUBLE_SAVE]: '同守同救',
  [DEATH_CAUSES.EXECUTION]: '投票放逐',
  [DEATH_CAUSES.SELF_DESTRUCT]: '自爆',
  [DEATH_CAUSES.HUNTER_SHOT]: '猎人开枪',
  [DEATH_CAUSES.WOLF_KING_SHOT]: '狼王带人',
  [DEATH_CAUSES.WHITE_WOLF_TAKE]: '白狼王带走',
};

/** 事件类别。台账里那些老行是 other，照普通行显示。 */
const EVENT_KIND_NAMES: Record<string, string> = {
  public_speech: '公开发言',
  wolf_speech: '狼队商议',
  public_summary: '公开发言摘要',
  wolf_summary: '狼队商议摘要',
  ballot: '票型',
  sheriff: '警长',
  other: '流程',
  system: '法官播报',
};

/** 行动类型。观战那头「正在写什么」按它取名。 */
const ACTION_NAMES: Record<string, string> = {
  [ACTION_TYPES.SPEECH]: '发言',
  [ACTION_TYPES.VOTE]: '投票',
  [ACTION_TYPES.DAY_END_JUDGMENT]: '日终个人判断',
  [ACTION_TYPES.WOLF_PROPOSAL]: '商量刀谁',
  [ACTION_TYPES.WOLF_DISCUSSION_CONTINUE]: '继续商议判断',
  [ACTION_TYPES.WOLF_EXPLODE]: '自爆判断',
  [ACTION_TYPES.SEER_CHECK]: '查验',
  [ACTION_TYPES.WITCH_DECISION]: '斟酌用药',
  [ACTION_TYPES.GUARD_PROTECT]: '守人',
  [ACTION_TYPES.HUNTER_SHOT]: '开枪',
  [ACTION_TYPES.WOLF_KING_SHOT]: '带人',
  [ACTION_TYPES.WHITE_WOLF_TAKE]: '带走',
  [ACTION_TYPES.SHERIFF_CANDIDACY]: '上警报名',
  [ACTION_TYPES.SHERIFF_WITHDRAW]: '退水判断',
  [ACTION_TYPES.SHERIFF_TRANSFER]: '定警徽去向',
  [ACTION_TYPES.SHERIFF_DECIDE_ORDER]: '定发言方向',
};

/** 走到了图里哪一步。生成之后可能再问一轮，那两轮手上不是同一件事。 */
const STEP_NAMES: Record<string, string> = {
  generate: '生成中',
  critique: '复核中',
  revise: '重做中',
};

function named(names: Record<string, string>, value: string): string {
  return names[value] ?? value;
}

export const roleName = (role: string) => named(ROLE_NAMES, role);
export const factionName = (faction: string) => named(FACTION_NAMES, faction);
export const statusName = (status: string) => named(STATUS_NAMES, status);
export const eventKindName = (kind: string) => named(EVENT_KIND_NAMES, kind);
export const deathCauseName = (cause: string) => named(DEATH_CAUSE_NAMES, cause);
export const actionTypeName = (actionType: string) => named(ACTION_NAMES, actionType);
export const stepName = (step: string) => named(STEP_NAMES, step);

/** 观战的两档视角：上帝看得见全部，闭眼只看得见在场的人都看得到的那几条。 */
export const PERSPECTIVES = {
  GOD: 'god',
  CLOSED: 'closed',
} as const;

export type Perspective = (typeof PERSPECTIVES)[keyof typeof PERSPECTIVES];

export const PERSPECTIVE_NAMES: Record<Perspective, string> = {
  [PERSPECTIVES.GOD]: '上帝视角',
  [PERSPECTIVES.CLOSED]: '闭眼视角',
};
