/**
 * 这条事实属于哪一类。
 * 取给谁看时按它分块：公开发言、狼队商议、票型、流程各成一块，模型一眼能看出这条是哪一种。
 * other 是这一类落地之前那些老行留下的，不为了好看把它们说成某一种。
 */
export const EVENT_KINDS = {
  PUBLIC_SPEECH: 'public_speech',
  WOLF_SPEECH: 'wolf_speech',
  /** 窗口外那几天的公开发言压成的摘要，一天一条，与公开发言同块。 */
  PUBLIC_SUMMARY: 'public_summary',
  /** 狼队商议那份的摘要，同上。 */
  WOLF_SUMMARY: 'wolf_summary',
  BALLOT: 'ballot',
  SHERIFF: 'sheriff',
  /** 法官提示和技能回执仅供观战，玩家上下文已包含当前局面与技能结果。 */
  SYSTEM: 'system',
  OTHER: 'other',
} as const;

export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];

/**
 * 事件的落库口子。
 *
 * 台账在内存里也能用，落库是为了「断了再起」：台账进每一次提问的可见事实，
 * 走过的那几问不再问模型，但它们记下的经过得原样铺回来，
 * 没走过的那几问也得看见这半局都发生过什么。
 */
export interface StoredEvent {
  /** 这一局的第几条，按发生顺序。同一局的顺序由写的人现排，不交给库。 */
  seq: number;
  /** 这条事实的身份，由这一次提问的行动键拼出来。同一局里写第二遍当同一件事。 */
  eventKey: string;
  day: number;
  text: string;
  kind: EventKind;
  /**
   * 这条事实发生那一刻谁看得到，存玩家 id。
   * 受众在那一刻定格、之后不再变：死者仍看得到生前的，女巫仍看得到用药前的。
   */
  audience: readonly string[];
}

/** 事件库。真跑那份落 Postgres，用例用内存替身。 */
export interface EventStore {
  /** 这局已经记下的，按发生顺序。 */
  list(gameId: string, after?: number): Promise<readonly StoredEvent[]>;
  positions(gameId: string): Promise<readonly Pick<StoredEvent, 'eventKey' | 'seq'>[]>;
  /** 记一条。同一个 eventKey 写第二遍是 bug：重放与同一趟里的重记各有拦处，能写到这一层就是有人越界了。 */
  append(gameId: string, event: StoredEvent): Promise<void>;
}
