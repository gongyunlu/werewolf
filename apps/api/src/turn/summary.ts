import { z } from 'zod';
import { InvalidOutputError } from '../llm/model-port';
import { toolOf } from './decisions';
import { ask, askParsed, noted, parseStructured, retryNote } from './graph';
import { renderSummary } from './prompt';
import type { TurnRuntime } from './request';

/**
 * 把窗口外那一整天的发言折成每人一条的摘要。
 *
 * 它不是玩家的一问，不进行动图：图那一套（立意图、检查点、质疑与修订）是给「牌桌上做决定」用的，
 * 而这一问是对着已经发生过的事做笔记，答完就落进台账，没有第二次机会，也没有什么可质疑的。
 * 借的是图里那两件通用的事——拿工具问一次、不合规再问几次。
 *
 * 折的是发言，别的都不折：票型、死讯、警徽、上警退水这些又短又密，压一句反而是把信息丢在压缩上。
 */

/** 一天里一个人说过的全部；他的座位号由调用方按局内对照表换好。 */
export interface SpeechToFold {
  seatNo: number;
  lines: readonly string[];
}

/** 摘要条目：谁、说了些什么的要点。 */
export interface SummaryItem {
  seatNo: number;
  gist: string;
}

/**
 * 每人一条，漏一个都不行。
 * 漏掉的那个人这一整天的发言就再没有别的地方留着了——明细已经折掉，摘要里又没有他。
 */
const summaryShape = (seatNos: readonly number[]) =>
  z.object({
    items: z.array(
      z.object({
        seatNo: z.literal([...seatNos] as [number, ...number[]]),
        gist: z.string().min(1),
      }),
    ),
  });

/** 交上来的条数与人对不上的话，就当成答得不合规，由上面那层带着原因再问。 */
function coverEveryone(items: readonly SummaryItem[], seatNos: readonly number[]): SummaryItem[] {
  const got = items.map((item) => item.seatNo);
  const missing = seatNos.filter((seatNo) => !got.includes(seatNo));
  // 「重了」也要点名是谁：这条诊断是重问时唯一能指路的东西，说成「条数不对」它还是只能重掷。
  const repeated = [...new Set(got.filter((seatNo, at) => got.indexOf(seatNo) !== at))];

  if (missing.length > 0 || repeated.length > 0) {
    // 两件可以同时成立（交重了谁，就等于漏了谁），所以是攒出来而不是二选一。
    const trouble: string[] = [];
    if (missing.length > 0) trouble.push(`少了 ${missing.join('、')} 号的发言`);
    if (repeated.length > 0) trouble.push(`${repeated.join('、')} 号交了两条`);

    throw new InvalidOutputError(
      `摘要少人或重人：该有 ${seatNos.join('、')}，交上来的是 ${JSON.stringify(items)}`,
      trouble.join('，'),
    );
  }
  return [...items];
}

/**
 * 问一次模型，把这一天的发言折成摘要。
 *
 * @param runtime 模型端口、接入身份与提示词的来处
 * @param input 哪一天、哪个渠道，以及这一天的发言
 * @returns 每人一条，顺序按模型交的来
 */
export async function summarize(
  runtime: TurnRuntime,
  input: {
    day: number;
    /** 频道的人话名，写进题面。 */
    channel: string;
    speeches: readonly SpeechToFold[];
  },
): Promise<readonly SummaryItem[]> {
  const seatNos = input.speeches.map((speech) => speech.seatNo);
  const schema = summaryShape(seatNos);
  const turn = await renderSummary(runtime.promptSource, {
    day: input.day,
    channel: input.channel,
    // 台账那几行的正文本来就以「N 号发言：」开头，不再自己补一遍座位号。
    speeches: input.speeches.map((speech) => speech.lines.join('\n')),
    count: seatNos.length,
    schemaJson: z.toJSONSchema(schema) as Record<string, unknown>,
  });

  const what = `第 ${input.day} 天${input.channel}的摘要`;
  const { parsed } = await askParsed(
    (note) =>
      ask(
        runtime.port,
        // 折摘要不是某个玩家在答，用整局的兜底那份接入身份。
        runtime.accessFor(null),
        note === null ? turn : noted(turn, note),
        toolOf(schema, `把这一天的${input.channel}压成每人一条`),
      ),
    (content) => coverEveryone(parseStructured(content, schema, what).items, seatNos),
    (raw, diagnosis) =>
      retryNote(
        seatNos.map((seatNo) => `${seatNo} 号`),
        raw,
        diagnosis,
      ),
  );

  return parsed;
}
