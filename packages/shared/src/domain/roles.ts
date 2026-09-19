/**
 * 角色取值域：规则里可能出现的角色标识，供板子配置和展示用。
 * 齐全不代表都实现了，能发牌的见 apps/api/src/core/roles.ts 的 DEALABLE_ROLES。
 * 只可追加，删改取值等于让事件与快照失去含义。
 */
export const ROLES = {
  // —— 好人阵营 ——
  VILLAGER: 'villager', // 平民

  // —— 好人阵营·神职 ——
  SEER: 'seer', // 预言家
  WITCH: 'witch', // 女巫
  HUNTER: 'hunter', // 猎人
  GUARD: 'guard', // 守卫
  IDIOT: 'idiot', // 白痴
  SAVIOR: 'savior', // 救世主
  KNIGHT: 'knight', // 骑士
  MAGICIAN: 'magician', // 魔术师
  ELDER: 'elder', // 长老
  BEAR: 'bear', // 熊（嗅探左右邻座）
  MEDIUM: 'medium', // 通灵师（查验被放逐者身份）
  GRAVEKEEPER: 'gravekeeper', // 守墓人
  DREAMWEAVER: 'dreamweaver', // 摄梦人
  CROW: 'crow', // 乌鸦
  GHOST: 'ghost', // 替罪羊（平票时代替平票玩家被放逐）
  DETECTIVE: 'detective', // 侦探

  // —— 狼人阵营 ——
  WEREWOLF: 'werewolf', // 狼人
  WOLF_KING: 'wolf_king', // 狼王
  WHITE_WOLF: 'white_wolf', // 白狼王
  WOLF_BEAUTY: 'wolf_beauty', // 狼美人
  HIDDEN_WOLF: 'hidden_wolf', // 隐狼
  STONE_WOLF: 'stone_wolf', // 石像鬼
  DEMON: 'demon', // 恶魔
  NIGHTMARE: 'nightmare', // 噩梦之影

  // —— 第三方阵营 ——
  CUPID: 'cupid', // 丘比特
  FOX: 'fox', // 咒狐（被查验时反噬预言家）
  THIEF: 'thief', // 盗贼
  BOMB: 'bomb', // 炸弹人（被放逐时带走所有投他票的玩家）
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];
