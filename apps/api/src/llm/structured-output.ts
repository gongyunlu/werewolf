import { z } from 'zod';
import { InvalidOutputError, type ModelTool } from './model-port';

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
 * 裹的是壳，不是形状本身——答案收回来要剥掉，由 parseStructured 校验并取出。
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

/**
 * 解析模型输出的那一串，再按 schema 校验一遍。
 * 三种失败归同一个错码：对调用方来说「不是 JSON」「壳没裹对」「值不对」是一件事——模型没照要求交。
 * 分成三句诊断是为了给模型看：它要照着那句话改，说成「不符合要求」等于没说。
 *
 * 不剥代码围栏、不抽片段：这几问都是走工具交的，拿到手的就是工具参数那一串 JSON。
 *
 * @param content 模型交上来的那一串
 * @param schema 要求的形状
 * @param what 出错信息里指代这份输出的说法，比如「3 号这次的决定」
 * @returns 校验过的结果
 */
export function parseStructured<S extends z.ZodType>(
  content: string,
  schema: S,
  what: string,
): z.infer<S> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new InvalidOutputError(
      `${what}不是合法 JSON；交上来的是 ${content}`,
      '整串不是合法 JSON',
      { cause: error },
    );
  }

  // 交上来的得是裹着壳的那个对象（顶层得是 object 才收，见 toolOf），
  // 那一层不是这次要交的东西，校验前先剥掉。壳本身没交对也算不合规——
  // 整串就是 null 的话，取 .value 抛的是裸 TypeError，上面那层认不出来，会跳过重问直接停掉整局。
  // 忘了裹壳（顶层是对象但没有 value）也算壳没交对：归到壳那一类，它会去补壳而不是改值。
  if (typeof parsed !== 'object' || parsed === null || !('value' in parsed)) {
    throw new InvalidOutputError(
      `${what}不是裹着壳的对象；交上来的是 ${content}`,
      '没裹在规定的那个对象里',
    );
  }
  const raw = (parsed as { value: unknown }).value;

  const checked = schema.safeParse(raw);
  if (!checked.success) {
    // 交上来的原物一并写进错里：只报「不符合要求」的话，跑完一局回来查不出它到底答了什么。
    throw new InvalidOutputError(
      `${what}不符合要求：${checked.error.message}；交上来的是 ${JSON.stringify(raw)}`,
      '交的那个值不合这次要求的形状',
      { cause: checked.error },
    );
  }
  return checked.data;
}
