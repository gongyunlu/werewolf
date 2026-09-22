import type {
  ModelAccess,
  ModelCallOptions,
  ModelPort,
  ModelRequest,
  ModelTool,
} from './model-port';

/** 一次提问：题面送出去那一刻的样子。答复是另一回事，崩掉的那一问根本没有答复。 */
export interface AskedPrompt {
  /** 用的哪个型号：同一局换过型号的话，题面一样也不是同一问。 */
  model: string;
  system: string;
  prompt: string;
  /** 这一问要它走的工具定义；要让模型写一段话的那几问（发言）不走工具。 */
  tool?: ModelTool;
}

/**
 * 给端口加一层：每一问送出去之前，先把这份提问落一份。
 *
 * 落的是发出去那一刻，不是答完之后：卡死在某一问时，那一问当初看到了什么在库里查得到——
 * 答完才写的那份快照这时候还不存在。
 *
 * 记不下来就当场抛、不往下发：库都写不进去了，这一局后面每一步的记录也写不进去，
 * 瞒着这一次发出去只是再欠一次「为什么库里没有那一行」。
 *
 * 这一层要包在重试那一层外面（见 retrying-model-port）：那边重发的是同一份题面，
 * 包在里面就是把同一份落好几遍；而「重问时附了什么」是解析那一层的重问，本来各是一次调用。
 */
export function recordingModelPort(
  port: ModelPort,
  record: (asked: AskedPrompt) => Promise<void>,
): ModelPort {
  return {
    async generate(request: ModelRequest, access: ModelAccess, call: ModelCallOptions = {}) {
      await record({
        model: access.model,
        system: request.system,
        prompt: request.prompt,
        tool: request.tool,
      });

      return port.generate(request, access, call);
    },
  };
}
