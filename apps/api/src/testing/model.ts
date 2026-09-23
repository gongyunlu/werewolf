import type { ModelPort, ModelRequest, ModelResponse } from '../llm/model-port';

/** 记下收到的每一次请求的模型替身；calls 用来断言问了几次、问的是什么。 */
export interface RecordingModel extends ModelPort {
  readonly calls: readonly ModelRequest[];
}

/**
 * 把替身要交的答案包成一次答复。
 *
 * 请求带了工具，答案就从工具那一头出去：真模型在那个口子上是被 tool_choice 逼着调工具的，
 * 替身照做，用例里的脚本才不必按有没有工具换写法。
 *
 * 参数裹着壳（见 decisions 的 toolOf），答案也跟着裹：模型看到的形状就是那么写的，
 * 它交回来的自然是 {value: ...}。脚本里写的仍是那个值本身。
 *
 * @param request 这次请求，用它决定答案从正文还是工具那一头出去
 * @param answer 脚本里写的那个值
 * @param reasoning 它写下这个答案之前那段推理；不关心的用例不必给
 */
export function responseOf(
  request: ModelRequest,
  answer: string,
  reasoning: string | null = null,
): ModelResponse {
  if (!request.tool) return { content: answer, toolCall: null, reasoning };

  return {
    content: '',
    toolCall: {
      name: request.tool.name,
      // 拼而不是 parse 再序列化：脚本给的本来就可能不是合法 JSON（那种用例正要看解析层怎么拦），
      // 在这儿先抛就成了替身自己的毛病，盖掉了要验的那一条。
      arguments: `{"value":${answer}}`,
    },
    reasoning,
  };
}

/**
 * 按一段逻辑作答的模型替身。
 * 它只看得见请求，答案也就只能从请求里推出来——这正是真模型的位置。
 */
export function answeringModel(answer: (request: ModelRequest) => string): RecordingModel {
  const calls: ModelRequest[] = [];

  return {
    calls,
    async generate(request: ModelRequest): Promise<ModelResponse> {
      calls.push(request);
      return responseOf(request, answer(request));
    },
  };
}

/** 脚本里的一格：交什么，以及写下它之前那段推理（写成带 reasoning 的那种才给）。 */
export type ScriptedStep =
  | string
  | Error
  | { answer: string; reasoning: string }
  /** 给了工具却只写了一段话，没走工具交——实测里模型会这么拒交。 */
  | { refusal: string; reasoning?: string };

/**
 * 造一个脚本模型。答案按调用次序消费，每次模型调用占一格。
 * 某一格放 Error 就是让这次调用失败。
 */
export function scriptedModel(answers: readonly ScriptedStep[]): RecordingModel {
  const calls: ModelRequest[] = [];
  let index = 0;

  return {
    calls,
    async generate(request: ModelRequest, _access, call): Promise<ModelResponse> {
      calls.push(request);
      const step = answers[index];
      index += 1;
      if (step === undefined) throw new Error(`脚本模型只准备了 ${answers.length} 次回答`);
      if (step instanceof Error) throw step;

      const response =
        typeof step === 'string'
          ? responseOf(request, step)
          : // 拒交那一格：给不给工具都不走它，正文就是它写的那段话。
            'refusal' in step
            ? { content: step.refusal, toolCall: null, reasoning: step.reasoning ?? null }
            : responseOf(request, step.answer, step.reasoning);

      // 真端口只要接了 onDelta 就边走边吐，这儿照做：用例才分得清「没走流」和
      // 「走了流却没人接」。走工具的那一问只有思考那一头，跟真端口一致。
      call?.onDelta?.({ channel: 'reasoning', text: '先想一下。' });
      if (!response.toolCall) call?.onDelta?.({ channel: 'content', text: response.content });

      return response;
    },
  };
}
