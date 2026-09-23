import { actorOfActionKey } from '../core/identity';
import { EVENT_KINDS, type EventKind, type EventStore, type StoredEvent } from '../store/events';
import type { FactBlock } from './request';

/**
 * 本局的公开过程台账：谁上过警、谁退过水、谁说了什么、警徽给了谁。
 *
 * Core 这些事算完就交回外层，自己不留（`DayResult.speeches` 就是被丢掉的那一份），
 * 而适配器是唯一见过答案的一方——答案由它递给 Core，顺手记一份在这里。
 *
 * 单人决定落定后记录发言、警徽去向和发言方向；上警、退水由 Core 收齐后统一发布。
 * 并发提问（投票、提刀、自爆）答完只是提案，成不成由 Core 收齐后按众数或座位序定，
 * 适配器看不到定局，记下去就成了拿提案冒充当结果——白狼王自爆那一问尤其明显，
 * 四只狼可能都答「爆」，真爆的只有座位最靠前的那只。
 * 并发提问还有第二个毛病：谁先答完由模型延迟决定，记进台账等于让提示词依赖网络时序。
 * 票型的定局 Core 拿得到，由它从 GameLoopInput.onBallot 交出来，适配器照记。
 *
 * 私密的那部分（查验结果、用药、守护）是各人底牌自带的，直接从局面读，见 context.ts。
 * 每条记下时带着「那一刻谁看得到」，取给谁看就按那份受众裁：受众在那一刻定格，
 * 死者仍看得到生前的，女巫仍看得到用药前的。
 *
 * 台账同时往事件库落一份。断了再起时这局是从阶段开头重走的，走过的那几问不再问模型，
 * 但它们记下的经过得照原样铺回来：少一条，后面那几问看到的上下文就缺了一截，
 * 同一格上问出来的东西跟前一次接不上。
 */
export interface Ledger {
  /**
   * 记一条事实。text 用第三人称写；audience 是这条事实发生那一刻看得到它的人。
   * key 是这条事实的身份：重放走过的路时，同一个 key 再记一遍不算新事实。
   */
  add(
    key: string,
    day: number,
    text: string,
    audience: readonly string[],
    kind: EventKind,
  ): Promise<void>;
  /** 台账记到第几条；一条都没有时是 0。 */
  lastSeq(): number;
  /**
   * 这个人看得到的那份，按类别分块、块内按天；他看不见的条目整条抽掉，抽空的那块不留。
   * upToSeq 给了就只到那一条为止，那是某一问问出去那一刻看到的那份。
   */
  factsFor(viewerId: string, upToSeq?: number): readonly FactBlock[];
  /** 窗口外、还没折的那几天，按天与渠道列出来，交给调用方去问模型。 */
  pendingSummaries(): readonly PendingSummary[];
  /** 记一条摘要。一天一条，正文是每人一行。 */
  addSummary(task: PendingSummary, text: string): Promise<void>;
}

/**
 * 发言原文留几天。近两天给逐字原文，更早的折成摘要。
 *
 * 定两天是因为前一天的原文正是「今天该投谁」的主要依据：昨天的票型、昨天的对跳、
 * 昨天的查验声明，全靠它。折成两句转述，当下这一步就没得推了。更早的那些天离得远，
 * 逐字留着只是占地方。
 */
export const LEDGER_WINDOW_DAYS = 2;

/** 台账里带说话人的那两类，以及它们各自折出来的摘要。 */
const CHANNELS: readonly { speech: EventKind; summary: EventKind }[] = [
  { speech: EVENT_KINDS.PUBLIC_SPEECH, summary: EVENT_KINDS.PUBLIC_SUMMARY },
  { speech: EVENT_KINDS.WOLF_SPEECH, summary: EVENT_KINDS.WOLF_SUMMARY },
];

/**
 * 各块在提示词里的先后，以及块标题；一块可以收好几类事实。
 * 顺序定死而不是按首次出现排：同一类事实在每一次提问里都落在同一块、同一位置，
 * 模型读到的形状固定，也省得相邻两问的块序不一样。
 * 摘要与它折的那些明细同块：它替的就是那几行，挪到别处读的人就得两头对。
 */
const BLOCKS: readonly { kinds: readonly EventKind[]; title: string }[] = [
  { kinds: [EVENT_KINDS.SHERIFF], title: '上警与警徽' },
  { kinds: [EVENT_KINDS.BALLOT], title: '票型' },
  { kinds: [EVENT_KINDS.PUBLIC_SPEECH, EVENT_KINDS.PUBLIC_SUMMARY], title: '公开发言' },
  { kinds: [EVENT_KINDS.WOLF_SPEECH, EVENT_KINDS.WOLF_SUMMARY], title: '狼队商议' },
  { kinds: [EVENT_KINDS.OTHER], title: '其它' },
];

/** 一天一条摘要，键由天与渠道拼出来，重放时按它认「这条已经折过了」。 */
function summaryKey(day: number, kind: EventKind): string {
  return `summary:${day}:${kind}`;
}

function isSummary(kind: EventKind): boolean {
  return kind === EVENT_KINDS.PUBLIC_SUMMARY || kind === EVENT_KINDS.WOLF_SUMMARY;
}

function isSpeech(kind: EventKind): boolean {
  return kind === EVENT_KINDS.PUBLIC_SPEECH || kind === EVENT_KINDS.WOLF_SPEECH;
}

/**
 * 折叠水位：这个位置属于第几天。
 *
 * 按位置所属的那一天算，不按「此刻是第几天」算。同一问在断点续跑时会重走一遍，
 * 那一次拿到的台账比当初厚，若按此刻的天算，同一问前后两次折出来的东西就不一样了。
 */
function watermarkDay(rows: readonly StoredEvent[], upToSeq?: number): number {
  let day = 0;
  for (const row of rows) {
    if (upToSeq !== undefined && row.seq > upToSeq) break;
    // 取最大而不是「最后一条说了算」：摘要那条的天号是有意写回过去的（它折的就是那一天），
    // 它一落库就排在最后，取最后一条的话水位会跟着退回去，后面再没有一天折得成。
    day = Math.max(day, row.day);
  }
  return day;
}

/** 这一天在不在窗口外。一条事实都还没记时水位是 0，那时什么都还没得折。 */
function folded(day: number, watermark: number): boolean {
  return day > 0 && day <= watermark - LEDGER_WINDOW_DAYS;
}

/**
 * 这条事实在这个水位下给不给。
 * 明细与摘要的取舍刚好相反：明细在窗口内才逐字给，摘要在窗口外才顶上。
 */
function covered(row: StoredEvent, watermark: number): boolean {
  if (isSummary(row.kind)) return folded(row.day, watermark);
  if (isSpeech(row.kind)) return !folded(row.day, watermark);
  return true;
}

/** 一天里某个渠道被折掉的那几条，归成一条待摘要的活。 */
export interface PendingSummary {
  /** 摘要自己的键，一局之内唯一，同一批并发提问靠它认「这条正在折」。 */
  key: string;
  day: number;
  /** 落到哪一块由它定。 */
  kind: EventKind;
  /** 这条摘要该给谁看：被折的那几条的受众合起来。 */
  audience: readonly string[];
  /** 被折的发言，按人归拢、按发言先后，每项是这个人在这一天说过的全部。 */
  speeches: readonly { actorId: string; lines: readonly string[] }[];
}

/**
 * 裁出这个人看得到的那几条，按类别分块；块内按天、天内按发生顺序，换天的时候前面插一行分隔。
 *
 * 先按天归拢再往上收拾：摘要那条是后补的，序号排在它折的那些明细之后，
 * 顺着序号一路走会把第 1 天的摘要排到第 3 天后面去。明细的天号单调不减，
 * 按天归拢与顺着走是同一个次序，摘要则落回它自己那一天、紧接着被它替掉的那几行。
 */
function render(
  rows: readonly StoredEvent[],
  viewerId: string,
  upToSeq?: number,
): readonly FactBlock[] {
  const watermark = watermarkDay(rows, upToSeq);

  const byDay = new Map<number, StoredEvent[]>();
  for (const row of rows) {
    const sameDay = byDay.get(row.day);
    if (sameDay) sameDay.push(row);
    else byDay.set(row.day, [row]);
  }

  return BLOCKS.map(({ kinds, title }) => {
    const lines: string[] = [];

    for (const [day, sameDay] of byDay) {
      const shown: string[] = [];
      for (const row of sameDay) {
        if (!kinds.includes(row.kind) || !covered(row, watermark)) continue;
        // 摘要那条不受这个记号管：它位置排在它折的那些明细之后，按位置裁会连同明细一起裁掉，
        // 那一整天就既没有明细也没有摘要。它折的全是这个记号之前的东西，给出来不越界。
        if (upToSeq !== undefined && row.seq > upToSeq && !isSummary(row.kind)) continue;
        if (!row.audience.includes(viewerId)) continue;

        // 摘要那条是一天一条、正文里每人一行，摊开来各占一行。
        shown.push(...row.text.split('\n'));
      }
      // 这一天没有他看得到的条目，天号那一行也不留。
      if (shown.length > 0) lines.push(`【第 ${day} 天】`, ...shown);
    }

    return { title, lines };
  }).filter((block) => block.lines.length > 0);
}

/**
 * 窗口外还没折的那几天。
 *
 * 一天一个渠道一条，折过的不再列：这一条本身也落库，续跑时跟着台账铺回来，
 * 于是「折过没有」不必另存一处，模型也不必为同一天再压一遍。
 */
function pendingSummaries(rows: readonly StoredEvent[]): readonly PendingSummary[] {
  const watermark = watermarkDay(rows);
  const done = new Set(
    rows.filter((row) => isSummary(row.kind)).map((row) => summaryKey(row.day, row.kind)),
  );

  const tasks: PendingSummary[] = [];
  for (const channel of CHANNELS) {
    const byDay = new Map<number, StoredEvent[]>();
    for (const row of rows) {
      if (row.kind !== channel.speech || !folded(row.day, watermark)) continue;
      const sameDay = byDay.get(row.day) ?? [];
      sameDay.push(row);
      byDay.set(row.day, sameDay);
    }

    for (const [day, speeches] of byDay) {
      const key = summaryKey(day, channel.summary);
      if (done.has(key)) continue;

      // 说话的人只写在键里（正文那句「3 号发言：…」是给人读的，不当判据），按人归拢得回到键上取。
      const byActor = new Map<string, string[]>();
      const audience = new Set<string>();
      for (const row of speeches) {
        const actorId = actorOfActionKey(row.eventKey);
        if (actorId === null) throw new Error(`发言那条事实的键不是行动键：${row.eventKey}`);

        const said = byActor.get(actorId) ?? [];
        said.push(row.text);
        byActor.set(actorId, said);
        for (const viewerId of row.audience) audience.add(viewerId);
      }

      tasks.push({
        key,
        day,
        kind: channel.summary,
        audience: [...audience],
        speeches: [...byActor].map(([actorId, lines]) => ({ actorId, lines })),
      });
    }
  }

  return tasks;
}

/**
 * 造一份台账。
 * stored 是这局已经落库的那几段，由持有这一局的人先取出来交进来：一局只取这一次，
 * 这一层就不必为了读一次历史把自己变成异步构造。
 */
export function ledger(store: EventStore, gameId: string, stored: readonly StoredEvent[]): Ledger {
  /** 已经发生的事实，按发生顺序；库里那几条先铺回来。 */
  const rows: StoredEvent[] = [...stored];
  /** 库里已经有的事实，重放时照着铺回内存，不再落第二遍。 */
  const loaded = new Set(stored.map((row) => row.eventKey));
  /** 这一趟记过的，用来认「同一问答了两遍」这种自己身上的毛病。 */
  const written = new Set<string>();
  /** 下一条事实的序号。 */
  let nextSeq = rows.at(-1)?.seq ?? 0;

  async function add(
    key: string,
    day: number,
    text: string,
    audience: readonly string[],
    kind: EventKind,
  ): Promise<void> {
    if (loaded.has(key)) return;
    // 一次提问记一条，键就是那次提问的行动键。一局之内撞上就是同一问答了两遍，
    // 那是序号发号器出了问题，当场炸比默默少记一条强。
    if (written.has(key)) throw new Error(`这一局已经记过 ${key}`);
    written.add(key);

    nextSeq += 1;
    const row: StoredEvent = { seq: nextSeq, eventKey: key, day, text, kind, audience };
    rows.push(row);
    await store.append(gameId, row);
  }

  return {
    add,

    lastSeq: () => rows.at(-1)?.seq ?? 0,

    // 交出去的是复印件：一次提问的上下文在问出去那一刻就定住，之后台账再怎么长都不该渗回去。
    // 同一轮里并发问出去的几个人看到的就是同一份台账，谁也不比谁多知道一条。
    // 记号取的是位置而不是那一问自己那条的键：投票、提刀这些提问答完不留事实，
    // 台账里根本没有它那一条，凭键只能落回整份。
    factsFor: (viewerId, upToSeq) => render(rows, viewerId, upToSeq),

    pendingSummaries: () => pendingSummaries(rows),

    addSummary: (task, text) => add(task.key, task.day, text, task.audience, task.kind),
  };
}
