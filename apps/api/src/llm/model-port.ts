import type { ModelCapability } from './model-capability';

/**
 * 模型调用的失败分类，决定调用方该不该重试。
 * transient 网络或限流、可以再来；invalid_output 输出不合结构、重采一次有机会；
 * circuit_open 本地熔断、等一会儿；fatal 重试也没用；deadline 阶段超期；
 * budget_exhausted 尝试次数用尽。
 * 具体哪些错误码归哪一类要等真实端点校准，这份类型先只定取值。
 */
export type ModelFailureCode =
  'transient' | 'invalid_output' | 'circuit_open' | 'fatal' | 'deadline' | 'budget_exhausted';

/** 失败时除错因之外还要往下传的东西。 */
export interface ModelCallErrorOptions extends ErrorOptions {
  /** 端点让过多久再来，毫秒。只有限流那类响应的头上会写，没写就是 undefined。 */
  retryAfterMs?: number;
  /** 这次失败之前已经吐出去一部分正文了。拿到手的东西收不回来，重发得另做打算。 */
  partialOutput?: boolean;
}

/** 模型调用失败。分类必须跟着错误一起传出去，调用方靠它决定重试还是放弃。 */
export class ModelCallError extends Error {
  constructor(
    readonly code: ModelFailureCode,
    message: string,
    options?: ModelCallErrorOptions,
  ) {
    super(message, options);
    this.name = 'ModelCallError';
    this.retryAfterMs = options?.retryAfterMs;
    this.partialOutput = options?.partialOutput;
  }

  readonly retryAfterMs?: number;
  readonly partialOutput?: boolean;
}

/**
 * 模型接入身份：端点、型号、密钥、这个接入点的能力。
 * 端点和密钥都不进任何冻结快照，见 turn/snapshot.ts。
 */
export interface ModelAccess {
  baseUrl: string;
  /** 型号。能力是按端点加型号查的，同一个端点上不同型号的收法不一样。 */
  model: string;
  /** 密钥。从环境变量读出来就是个常量，不在这儿做异步取值的口子。 */
  apiKey: string;
  capability: ModelCapability;
}

/** 一次模型请求。提示词怎么拼由调用方决定，端口不管内容。 */
export interface ModelRequest {
  /** 系统提示词：这名玩家是谁、守着哪些规矩。 */
  system: string;
  /** 用户提示词：这一刻的局面与这次要定的事。 */
  prompt: string;
}

export interface ModelResponse {
  /** 模型原文。是不是结构化由调用方自己解析，端口不替它判。 */
  content: string;
}

/** 模型端口：一次行动里所有对模型的请求都从这里出去。 */
export interface ModelPort {
  /**
   * 要一份答复。
   *
   * 给了 onDelta 就走流式：收到一段交出去一段，返回值仍是拼起来的全文；不给就一次收完。
   * 合成一个方法是为了让调用方不用分辨手里这个端口是哪一种。
   */
  generate(
    request: ModelRequest,
    access: ModelAccess,
    onDelta?: (delta: string) => void,
  ): Promise<ModelResponse>;
}
