import type { ModelPort, ModelRequest, ModelResponse } from '../llm/model-port';

/** 记下收到的每一次请求的模型替身；calls 用来断言问了几次、问的是什么。 */
export interface RecordingModel extends ModelPort {
  readonly calls: readonly ModelRequest[];
}

/**
 * 按一段逻辑作答的模型替身。
 * 它只看得见提示词，答案也就只能从提示词里推出来——这正是真模型的位置。
 */
export function answeringModel(answer: (request: ModelRequest) => string): RecordingModel {
  const calls: ModelRequest[] = [];

  return {
    calls,
    async generate(request: ModelRequest): Promise<ModelResponse> {
      calls.push(request);
      return { content: answer(request) };
    },
  };
}

/**
 * 造一个脚本模型。答案按调用次序消费，每次模型调用占一格。
 * 某一格放 Error 就是让这次调用失败。
 */
export function scriptedModel(answers: readonly (string | Error)[]): RecordingModel {
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
