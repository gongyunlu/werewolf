import { z } from 'zod';
import { DayEndJudgmentSchema, type DayEndJudgment } from '@werewolf/shared';
import type { ModelTool } from '../llm/model-port';

/**
 * 决定形状：这次问出去的东西长什么样子，以及模型交回来的答案怎么换回 Core 要的值。
 *
 * 模型答座位号，不答玩家 id：id 是引擎内部的串，模型既看不见也不该看见，座位号才是牌桌上通用的说法。
 * 两个方向的换算都在这一个文件里，改一处不会漏另一处。
 *
 * 形状一律从 Core 递过来的候选集现算，不照端口签名另抄一份：抄一份就多一处「候选改了这里要跟着改」，
 * 漏改的表现只是模型答了个非法目标，看着像模型不听话，其实是抄漏了。
 */

/** 交答案的那个工具的名字。一次只给一个工具，名字不必跟着形状变。 */
const TOOL_NAME = 'submit';

/**
 * 把校验 schema 转成给模型看的那份工具定义。
 *
 * 剥掉顶层的 $schema：那是 JSON Schema 给自己写的版本声明，与这次要交的东西无关。
 * 留着它实测有代价——模型会把整块 definition 原样抄回来交差，那一块正是从这儿出去的样子。
 *
 * 形状一律裹进一个单字段的对象：工具参数只收 object 的 JSON Schema，座位号（{enum: [...]}）、
 * 是非题、女巫那三选一直接发出去，端点是把整份请求一起拒掉，一句「参数不合规」就没了。
 * 裹的是壳，不是形状本身——答案收回来要剥掉，剥在 graph 的 parseStructured 那一处。
 */
export function toolOf(schema: z.ZodType, description: string): ModelTool {
  const json = { ...(z.toJSONSchema(schema) as Record<string, unknown>) };
  delete json.$schema;

  return {
    name: TOOL_NAME,
    description,
    parameters: {
      type: 'object',
      properties: { value: json },
      required: ['value'],
      additionalProperties: false,
    },
  };
}

/** 座位号取值集：候选里有几个座位，答案就只有哪几个。 */
function seats(seatNos: readonly number[]): z.ZodType<number> {
  if (seatNos.length === 0) throw new Error('候选为空，定不出可选座位');
  return z.literal([...seatNos] as [number, ...number[]]);
}

/** 可选一个座位，也可以不做：弃票、空刀、空守、不带人都是这个形状。 */
function optionalSeat(seatNos: readonly number[]): z.ZodType {
  return seats(seatNos).nullable();
}

/**
 * 要么救下今晚的刀口，要么毒一个人，要么都不用。
 * 两药不能同夜并用，所以是三选一而不是两个布尔。
 *
 * 哪几支摆得出来按 Core 的同一条规则现算：刀口是她自己时不能自救，毒药都用掉了就没有可毒的人。
 * 摆出来又让人选，选了再由 Core 抛错，等于把规则的判断推到了错误处理里。
 */
function witchChoice(poisonSeatNos: readonly number[], antidoteAllowed: boolean): z.ZodType {
  const branches: z.ZodType[] = [];
  if (antidoteAllowed) branches.push(z.object({ kind: z.literal('antidote') }));
  if (poisonSeatNos.length > 0) {
    branches.push(z.object({ kind: z.literal('poison'), seatNo: seats(poisonSeatNos) }));
  }
  const none = z.object({ kind: z.literal('none') });
  // Core 只在至少一支能用时才叫醒她，所以「都不用」之外至少还有一支。
  return branches.length === 0 ? none : z.union([...branches, none]);
}

/** 警徽交给谁，或者撕掉。 */
function badgeChoice(seatNos: readonly number[]): z.ZodType {
  return z.union([
    z.object({ kind: z.literal('transfer'), seatNo: seats(seatNos) }),
    z.object({ kind: z.literal('tear') }),
  ]);
}

type WitchAnswer = { kind: 'antidote' } | { kind: 'poison'; seatNo: number } | { kind: 'none' };
type BadgeAnswer = { kind: 'transfer'; seatNo: number } | { kind: 'tear' };

/**
 * 形状名到答案类型的对照。名字按「模型要交出来的东西」取，不按端口方法取：
 * 多个端口共用同一个形状是常态，投票和空刀在模型眼里是同一件事。
 */
export interface DecisionShapes {
  judgment: DayEndJudgment;
  /** 一个座位号，或者不做（null）。 */
  seatOrNone: string | null;
  /** 必须给一个座位号，没有不做这一档。 */
  seat: string;
  /** 救、毒、都不用。 */
  witchDecision: { kind: 'antidote' } | { kind: 'poison'; targetId: string } | { kind: 'none' };
  /** 警徽移交给谁，或者撕毁。 */
  badgeDecision: { kind: 'transfer'; toId: string } | { kind: 'tear' };
  /** 做或不做。 */
  yesOrNo: boolean;
  /** 从左边还是右边开始，取值同 SpeechSide。 */
  speechSide: 'left' | 'right';
  /** 一段话，没有形状可校验。 */
  speech: string;
}

export type DecisionShapeName = keyof DecisionShapes;

/** 一份决定形状的两个方向。 */
export interface DecisionShape {
  /** 交给行动图的校验 schema；发言没有 schema，草稿原文就是结果。 */
  schema: z.ZodType | undefined;
  /**
   * 把校验过的答案换回 Core 要的值，返回类型见 DecisionShapes 里同名那一项。
   * 这里只能回 unknown：形状名是运行期取值，编译期认不出该是哪一项，认领放在调用它的那一处。
   */
  toCore(decision: unknown, toPlayerId: (seatNo: number) => string): unknown;
}

/** 造形状要的那点输入。 */
export interface ShapeInput {
  /** 这次能选的座位号，由候选玩家算出来，顺序与候选一致。 */
  seatNos: readonly number[];
  /** 解药那一支摆不摆得出来。只有女巫那一问用得上，其余形状不看它。 */
  antidoteAllowed?: boolean;
}

/**
 * 造这次提问的形状。
 *
 * @param name 形状名
 * @param input 候选座位号，以及只有女巫那一问看得的可用药判断
 */
export function decisionShape(name: DecisionShapeName, input: ShapeInput): DecisionShape {
  const { seatNos } = input;

  switch (name) {
    case 'judgment':
      return { schema: DayEndJudgmentSchema, toCore: (decision) => decision };
    case 'speech':
      return { schema: undefined, toCore: (decision) => decision };
    case 'yesOrNo':
      return { schema: z.boolean(), toCore: (decision) => decision };
    case 'speechSide':
      return { schema: z.enum(['left', 'right']), toCore: (decision) => decision };
    case 'seat':
      return {
        schema: seats(seatNos),
        toCore: (decision, toPlayerId) => toPlayerId(decision as number),
      };
    case 'seatOrNone':
      return {
        schema: optionalSeat(seatNos),
        toCore: (decision, toPlayerId) =>
          decision === null ? null : toPlayerId(decision as number),
      };
    case 'witchDecision': {
      // 不给默认值：默认「能用」等于替 Core 做主摆出一支她那晚用不了的解药，
      // 默认「不能用」则是把规则悄悄改掉。两种都不如让漏传的调用点当场停下来。
      const { antidoteAllowed } = input;
      if (antidoteAllowed === undefined) throw new Error('女巫那一问要说清解药能不能用');

      return {
        schema: witchChoice(seatNos, antidoteAllowed),
        toCore: (decision, toPlayerId) => {
          const answer = decision as WitchAnswer;
          return answer.kind === 'poison'
            ? { kind: 'poison', targetId: toPlayerId(answer.seatNo) }
            : { kind: answer.kind };
        },
      };
    }
    case 'badgeDecision':
      return {
        schema: badgeChoice(seatNos),
        toCore: (decision, toPlayerId) => {
          const answer = decision as BadgeAnswer;
          return answer.kind === 'transfer'
            ? { kind: 'transfer', toId: toPlayerId(answer.seatNo) }
            : { kind: 'tear' };
        },
      };
  }
}
