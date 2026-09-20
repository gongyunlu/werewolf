import type { ModelPort, ModelRequest, ModelResponse } from '../llm/model-port';

/** 按次序给预设回答的模型；回答用完了再被问就当场失败。 */
export interface ScriptedModel extends ModelPort {
  /** 依次收到的请求，用来断言问了几次、问的是什么。 */
  readonly calls: readonly ModelRequest[];
}

/**
 * 造一个脚本模型。答案按调用次序消费，每次模型调用占一格。
 * 某一格放 Error 就是让这次调用失败。
 */
export function scriptedModel(answers: readonly (string | Error)[]): ScriptedModel {
  const calls: ModelRequest[] = [];
  let index = 0;

  return {
    calls,
    async generate(request: ModelRequest): Promise<ModelResponse> {
      calls.push(request);
      const answer = answers[index];
      index += 1;
      if (answer === undefined) throw new Error(`脚本模型只准备了 ${answers.length} 次回答`);
      if (answer instanceof Error) throw answer;
      return { content: answer };
    },
  };
}
