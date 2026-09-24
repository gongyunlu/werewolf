import type { ModelCapability } from './model-capability';
import type { AttemptCompletion, CallIdentity } from './observation';

/**
 * 模型调用的失败分类，决定调用方该不该重试。
 * transient 网络或限流、可以再来；invalid_output 输出不合结构、重采一次有机会；
 * fatal 重试也没用；deadline 阶段超期；
 * budget_exhausted 尝试次数用尽。
 * 具体哪些错误码归哪一类要等真实端点校准，这份类型先只定取值。
 */
export type ModelFailureCode =
  'transient' | 'invalid_output' | 'fatal' | 'deadline' | 'budget_exhausted';

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
 * 交上来的东西不合规定的结构。
 * message 进日志，写清是什么东西、交上来的是什么；diagnosis 是给模型看的那一句，
 * 只说错在哪一类——重问时它要照着这句改，说成「不符合要求」等于没说。
 */
export class InvalidOutputError extends ModelCallError {
  constructor(
    message: string,
    readonly diagnosis: string,
    options?: ModelCallErrorOptions,
  ) {
    super('invalid_output', message, options);
    this.name = 'InvalidOutputError';
  }
}

/**
 * 模型接入身份：端点、型号、密钥、这个接入点的能力。
 * 端点和密钥都不进快照，见 turn/snapshot.ts。
 */
export interface ModelAccess {
  baseUrl: string;
  /** 型号。能力是按端点加型号查的，同一个端点上不同型号的收法不一样。 */
  model: string;
  /** 密钥。从环境变量读出来就是个常量，不在这儿做异步取值的口子。 */
  apiKey: string;
  capability: ModelCapability;
}

/** 一份工具定义。要模型按固定形状交东西时给这个，比在提示词里贴 schema 硬。 */
export interface ModelTool {
  name: string;
  /** 这次要它交什么，给模型看的说明。 */
  description: string;
  /** 参数的 JSON Schema。 */
  parameters: Record<string, unknown>;
}

/** 一次模型请求。提示词怎么拼由调用方决定，端口不管内容。 */
export interface ModelRequest {
  /** 系统提示词：这名玩家是谁、守着哪些规矩。 */
  system: string;
  /** 用户提示词：这一刻的局面与这次要定的事。 */
  prompt: string;
  /**
   * 要它走这个工具交答案；不给就是让它写一段话。
   * 一次只给一个：这几问每次只要一件东西，没有多工具的场景。
   */
  tool?: ModelTool;
}

export interface ModelResponse {
  /** 解析结束后补写逻辑调用结果；只存在于内存，不写入图状态。 */
  completeObservation?: (status: 'accepted' | 'invalid_output' | 'failed') => Promise<void>;
  /** 首个推理片段到开始输出答案的时长；非流式调用无法测量。 */
  thinkingMs?: number;
  /** 模型原话。走工具时是空串——答案在 toolCall 那一头。 */
  content: string;
  /** 走工具交上来的那份参数，原样一串 JSON 文本；没走工具就是 null。 */
  toolCall: { name: string; arguments: string } | null;
  /**
   * 交答案之前它自己那段推理，原文。跟 content 是分开的两段，各说各的。
   * 这一问端点没给（思考关着、或这一家本来就不给）就是 null。
   */
  reasoning: string | null;
}

/** 流式吐出来的一段。两段正文各有各的通道，走工具时只有思考那一头有东西。 */
export interface StreamDelta {
  thinkingMs?: number;
  /** 思考是模型自己那段推理，正文是它交出来的话；两者各走各的，不交错。 */
  channel: 'reasoning' | 'content';
  text: string;
}

/** 一次调用的可选口子。一次调用一个，不进端口的构造参数。 */
export interface ModelCallOptions {
  identity?: CallIdentity;
  /** 适配器进入和离开一次 SDK 请求时调用，写库在 SDK 错误转换之外。 */
  startAttempt?: () => Promise<{
    dispatched(): void;
    finish(result: AttemptCompletion): Promise<void>;
  }>;
  /**
   * 给了就走流式：收到一段交出去一段，返回值仍是拼起来的全文；不给就一次收完。
   * 合成一个方法是为了让调用方不用分辨手里这个端口是哪一种。
   *
   * 两个通道都从这儿走，工具参数不从这儿走——那串 JSON 推到一半没有可读的东西。
   * 所以走工具的那几问只会收到 reasoning；端点关着思考时一段都收不到。
   */
  onDelta?: (delta: StreamDelta) => void;
  /** 调用方中止这次调用。已经吐出去的字收不回来，会带着 partialOutput 抛。 */
  signal?: AbortSignal;
  /** 这一次的上限毫秒数，不给就用端口自己的。 */
  timeoutMs?: number;
}

/** 模型端口：一次行动里所有对模型的请求都从这里出去。 */
export interface ModelPort {
  /** 要一份答复。 */
  generate(
    request: ModelRequest,
    access: ModelAccess,
    options?: ModelCallOptions,
  ): Promise<ModelResponse>;
}
