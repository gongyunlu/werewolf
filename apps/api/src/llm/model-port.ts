import type { ModelCapability } from './model-capability';

/**
 * 模型调用的失败分类，决定调用方该不该重试。
 * transient 网络或限流、可以再来；invalid_output 输出不合结构、重发同样的问也可能再错；
 * circuit_open 本地熔断、等一会儿；fatal 重试也没用；deadline 阶段超期；
 * budget_exhausted 尝试次数用尽。
 * 具体哪些错误码归哪一类要等真实端点校准，这份类型先只定取值。
 */
export type ModelFailureCode =
  'transient' | 'invalid_output' | 'circuit_open' | 'fatal' | 'deadline' | 'budget_exhausted';

/** 模型调用失败。分类必须跟着错误一起传出去，调用方靠它决定重试还是放弃。 */
export class ModelCallError extends Error {
  constructor(
    readonly code: ModelFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ModelCallError';
  }
}

/**
 * 模型接入身份：端点、密钥、这个接入点的能力。
 * 密钥写成惰性函数，只在真要发请求时求值——端点和密钥都不进任何冻结快照。
 */
export interface ModelAccess {
  baseUrl: string;
  apiKey: string | (() => Promise<string>);
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
  generate(request: ModelRequest, access: ModelAccess): Promise<ModelResponse>;
}
