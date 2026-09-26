import { KnowledgeContentSchema, type KnowledgeContent } from '@werewolf/shared';

const boards = ['12p_wolf_king', '12p_white_wolf'];
const sources = {
  guard: {
    title: '守卫攻略 | 最深情的黑夜守护者',
    publisher: '网易狼人杀',
    author: '',
    url: 'https://langrensha.com/hantiao/mengxin/2019/04/03/26895_807385.html',
    publishedOn: '2019-04-03',
  },
  seer: {
    title: '预言家攻略（上）',
    publisher: '网易狼人杀',
    author: '轩舞',
    url: 'https://langrensha.com/hantiao/juese/2018/07/09/26896_763561.html',
    publishedOn: '2018-07-09',
  },
  wolf: {
    title: '悍跳核心问题以及狼人悍跳收益分析',
    publisher: 'langrensha.net',
    author: '',
    url: 'https://www.langrensha.net/strategy/2021061502.html',
    publishedOn: '2021-06-15',
  },
  white: {
    title: '白狼王玩法攻略',
    publisher: 'langrensha.net',
    author: '',
    url: 'https://www.langrensha.net/strategy/2022092201.html',
    publishedOn: '2022-09-22',
  },
  rules: {
    title: '狼人杀游戏规则',
    publisher: '网易狼人杀',
    author: '',
    url: 'https://langrensha.com/wanfa/guize/2017/10/18/26899_719311.html',
    publishedOn: '2017-10-18',
  },
  interview: {
    title: '2025年狼人杀英雄联赛总决赛冠军初次拥抱采访',
    publisher: '网易狼人杀',
    author: '',
    url: 'https://langrensha.com/20251010/31012_1263944.html',
    publishedOn: '2025-10-10',
  },
};
function entry(
  n: number,
  source: keyof typeof sources,
  locator: string,
  content: Omit<KnowledgeContent, 'sources' | 'rulesBasis' | 'minDay'> & { minDay?: number },
) {
  return {
    id: `ec572026-0926-4000-8000-${String(n).padStart(12, '0')}`,
    content: KnowledgeContentSchema.parse({
      ...content,
      rulesBasis: '本项目当前板型与 Core 合法操作；整理基于 bf857ba，不将网页规则替代游戏规则',
      sources: [{ ...sources[source], locator, checkedOn: '2026-09-26' }],
    }),
  };
}

/** 人工核对后的简短整理，来源观点与本项目适配分别保存。 */
export const INITIAL_KNOWLEDGE = [
  entry(1, 'guard', '第一夜守护选择', {
    kind: 'strategy',
    title: '首夜自守与空守的取舍',
    body: '作者比较首夜自守与空守：前者保障自身，却限制下一夜选择；后者保留选择空间，同时承担被刀风险。',
    conditions: '首夜守护，板上存在女巫；自身没有昨夜守护记录。',
    adaptation:
      '只能选当前合法目标或空守。守卫看不到女巫决定，不能假定其必救；同守同救规则以当前技能输入为准。',
    boardIds: boards,
    roles: ['guard'],
    actionTypes: ['guard_protect'],
    firstDayOnly: true,
  }),
  entry(2, 'guard', '第二夜守护选择', {
    kind: 'strategy',
    title: '预言家对跳时分开评估守护目标',
    minDay: 2,
    body: '文章在双预言家与单边预言家的情形下给出不同守护思路，提醒守卫比较自守、保护可信好人与保护预言家的收益。',
    conditions: '白天出现预言家声明后的夜晚；结合可见发言与本人守护记录。',
    adaptation:
      '单边声明不等于身份认证。比较目标存活价值、受刀风险和不可连守限制；不知道女巫用药时保留不确定性。',
    boardIds: boards,
    roles: ['guard'],
    actionTypes: ['guard_protect'],
    firstDayOnly: false,
  }),
  entry(3, 'guard', '第三夜及之后', {
    kind: 'strategy',
    title: '守护决策同时检查神职与平民压力',
    minDay: 3,
    body: '作者讨论后续夜晚应关注神职和平民的损失，以及自身身份暴露后的守护取舍。',
    conditions: '中后期守护，有可见出局信息与身份声明可供比较。',
    adaptation:
      '死亡不自动揭示身份，公开报药也不是药量事实。仅据本人视角列出可能局面，再在合法选项内比较生存压力，不从攻略补全隐藏身份。',
    boardIds: boards,
    roles: ['guard'],
    actionTypes: ['guard_protect'],
    firstDayOnly: false,
  }),
  entry(4, 'seer', '高置位发言', {
    kind: 'strategy',
    title: '较早竞选发言保留警徽流解释空间',
    body: '作者认为较早发言时可利用警徽流争取支持，但此时尚未听完发言，可依据后续信息调整查验考虑。',
    conditions: '首日竞选发言，预言家较早发言且尚未听完其他竞选者。',
    adaptation:
      '警徽流只是发言中的计划，不是已完成查验。真实查验结果、计划和拉票理由分别表述；不把作者的强制上警偏好变成规则。',
    boardIds: boards,
    roles: ['seer'],
    actionTypes: ['speech'],
    firstDayOnly: true,
  }),
  entry(5, 'seer', '中置位与末置位发言', {
    kind: 'strategy',
    title: '较晚竞选发言解释查验计划的依据',
    body: '文章区分中置位与末置位的信息量，建议结合已经听到的发言疑点安排警徽流。',
    conditions: '首日竞选发言，已经听到部分或全部其他竞选者的发言。',
    adaptation:
      '说清具体发言与疑点，不按发言位置直接定身份。计划随证据变化，不将尚未查验者称为查杀或金水。',
    boardIds: boards,
    roles: ['seer'],
    actionTypes: ['speech'],
    firstDayOnly: true,
  }),
  entry(6, 'wolf', '悍跳前的准备和队伍分工', {
    kind: 'strategy',
    title: '悍跳准备具体到声明与票型',
    body: '文章建议悍跳前明确伪查验、警徽流，以及队友支持或疏离的配合，避免临场声明和投票互相冲突。',
    conditions: '狼队商议拟定或检查悍跳安排；公开发言时仅使用可公开的部分。',
    adaptation:
      '原文含普通狼与白痴板，不能照搬角色数或技能。仅作队内计划；队友未同意的分工不是事实，私密商议不能作为公开论据。',
    boardIds: boards,
    roles: ['werewolf'],
    actionTypes: ['speech', 'wolf_proposal'],
    firstDayOnly: false,
  }),
  entry(7, 'white', '白狼王争警徽与隐藏身份', {
    kind: 'strategy',
    title: '白狼王比较争徽与隐藏的机会成本',
    body: '文章比较争取警徽和隐藏寻找神职的收益；白狼王是否暴露应与队伍安排及带人机会共同考虑。',
    conditions: '白狼王在竞选或发言、自爆选择前，尚可自主行动。',
    adaptation:
      '不能因攻略将任何声明神职者视为真神。只能在引擎实际提供的自爆窗口行动，不照搬网页的时点。',
    boardIds: ['12p_white_wolf'],
    roles: ['white_wolf'],
    actionTypes: ['sheriff_candidacy', 'speech', 'wolf_explode'],
    firstDayOnly: false,
  }),
  entry(8, 'white', '自刀与自爆带人的风险', {
    kind: 'strategy',
    title: '白狼王行动前考虑技能损失',
    body: '文章提醒白狼王自刀可能损失白天自爆带人的机会，不能只按普通狼的自刀收益衡量。',
    conditions: '白狼王参与夜间提刀或面对自爆、带人选择。',
    adaptation:
      '区分夜死与自爆；是否能带人由当前合法操作决定。目标价值取决于本局可见证据，网页中的固定目标优先级不直接套用。',
    boardIds: ['12p_white_wolf'],
    roles: ['white_wolf'],
    actionTypes: ['wolf_proposal', 'wolf_kill', 'wolf_explode', 'white_wolf_take'],
    firstDayOnly: false,
  }),
  entry(9, 'rules', '12人狼王守卫、白狼王守卫板型', {
    kind: 'rule',
    title: '外部十二人板型与守卫规则参考',
    body: '页面列出多种人数和角色组合，并介绍守卫不能连续两夜守同一目标。此条用于查阅来源。',
    conditions: '人工核对本项目两个十二人板与外部规则差异。',
    adaptation:
      '页面含遗言规则，白狼王板列表和角色说明也有不一致，不能整页导入为本局权威规则。当前游戏仍以 Core 和技能规则为准。',
    boardIds: boards,
    roles: [],
    actionTypes: [],
    firstDayOnly: false,
  }),
  entry(10, 'interview', '问题8：选手回顾高光场次', {
    kind: 'case',
    title: '赛事访谈中的平民跳守卫回忆',
    body: '乐事回忆第五局以平民身份跳守卫挡刀；同篇访谈也有狼人跳守卫的回忆，说明同一种身份声明可能服务不同目的。',
    conditions: '仅用于人工阅读案例，不作为本局推断或通用操作建议。',
    adaptation:
      '访谈未提供完整逐行动记录、信息边界和板型细节，也存在赛事积分因素；不能据此认定跳守卫就是平民或狼人。',
    boardIds: [],
    roles: [],
    actionTypes: [],
    firstDayOnly: false,
  }),
];
